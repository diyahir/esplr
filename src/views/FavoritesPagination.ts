import { AddressCache } from '@/cache';
import type { TransactionListItem } from '@/types';
import {
  getLatestTxnsWithBlockDetails,
  getTransactionsAfterWithBlockDetails,
  getTransactionsBeforeWithBlockDetails,
} from '@/utils/network';
import { txnsWithBlockDetailsToTxnsList, removeTxnsListItemsDuplicates } from '@/utils/utils';
import { Pagination } from '@/views/Pagination';
import { Web3Provider } from 'micro-eth-signer/net';

export class FavoritesPagination {
  private static instance: FavoritesPagination;

  private prov: Web3Provider;
  private pageSize: number;
  private pagination: Pagination;
  private cache: AddressCache | undefined;

  nextPageReminder: TransactionListItem[][] = [];
  prevPageReminder: TransactionListItem[][] = [];
  currentPageTxns: TransactionListItem[][] = [];

  // needed for checking if we on the first or last page
  firstTxnHash: string = '';
  lastTxnHash: string = '';

  firstPage: boolean = false;
  lastPage: boolean = false;
  page: number = 1;

  private constructor(prov: Web3Provider, pageSize: number, cache?: AddressCache) {
    this.prov = prov;
    this.pageSize = pageSize;
    this.pagination = Pagination.getInstance(prov, pageSize);
    this.cache = cache;
  }

  static getInstance(
    prov: Web3Provider,
    pageSize: number,
    cache?: AddressCache
  ): FavoritesPagination {
    if (!FavoritesPagination.instance) {
      FavoritesPagination.instance = new FavoritesPagination(prov, pageSize, cache);
    }
    return FavoritesPagination.instance;
  }

  clear(): void {
    this.nextPageReminder = [];
    this.prevPageReminder = [];
    this.currentPageTxns = [];
    this.firstTxnHash = '';
    this.lastTxnHash = '';
    this.firstPage = false;
    this.lastPage = false;
  }

  async showFirstPage(
    addresses: string[],
    data: TransactionListItem[][] | null = null
  ): Promise<TransactionListItem[][]> {
    this.clear();
    const { cache } = this;

    let allTxns: TransactionListItem[][] = [];
    if (data) {
      allTxns = data;
    } else {
      const addressesFirstPage = await Promise.all(
        addresses.map(async (address) => {
          const result = txnsWithBlockDetailsToTxnsList(
            await getLatestTxnsWithBlockDetails(this.prov, address, this.pageSize)
          );
          if (cache) {
            cache.addInternalTransactions(address, result);
          }
          return result;
        })
      );

      allTxns = removeTxnsListItemsDuplicates(addressesFirstPage.flat())

      allTxns.sort((a, b) => {
        if (a[0].timestamp === '-') return 1;
        if (b[0].timestamp === '-') return -1;
        return Number(b[0].timestamp) - Number(a[0].timestamp);
      });
    }

    this.prevPageReminder = [];
    this.currentPageTxns = allTxns.slice(0, this.pageSize);

    // put to reminder only txns from current page last block,
    // because next blocks may be unrelevant for the next page for some addresses
    // for the next page we should make new request to not miss any txns
    const reminder = allTxns.slice(this.pageSize);
    const lastTxnBlock = this.currentPageTxns[this.currentPageTxns.length - 1][0].blockNumber;
    this.nextPageReminder = reminder.filter((txn) => txn[0].blockNumber === lastTxnBlock);

    this.firstTxnHash = this.currentPageTxns[0][0].hash;

    this.firstPage = true;
    this.page = 1;
    this.lastPage = await this.checkIsLastPage(addresses);

    return this.currentPageTxns;
  }

  private async checkIsLastPage(addresses: string[]): Promise<boolean> {
    if (this.page === -1) {
      return true;
    }

    if (this.lastTxnHash === this.currentPageTxns[this.currentPageTxns.length - 1][0].hash) {
      return true;
    }

    if (this.currentPageTxns.length < this.pageSize) {
      return true;
    }

    if (this.currentPageTxns.length === this.pageSize && this.nextPageReminder.length === 0) {
      return !(await this.hasMoreTxnsBeforeAddresses(addresses));
    }

    return false;
  }

  private hasMoreTxnsBeforeAddresses = async (addresses: string[]): Promise<boolean> => {
    const addressesHasMoreTxns = await Promise.all(
      addresses.map(async (address) => {
        return await this.hasMoreTxnsBefore(address);
      })
    );
    return addressesHasMoreTxns.some((hasMore) => hasMore);
  };

  private hasMoreTxnsBefore = async (address: string): Promise<boolean> => {
    const lastTxnBlock = parseInt(
      this.currentPageTxns[this.currentPageTxns.length - 1][0].blockNumber
    );
    const txnsCountToLoad = 1;
    const moreTxns = await getTransactionsBeforeWithBlockDetails(
      this.prov,
      address,
      lastTxnBlock,
      txnsCountToLoad
    );
    return moreTxns.length > 0;
  };

  async showNextPage(addresses: string[]): Promise<TransactionListItem[][]> {
    if (this.lastPage) {
      this.nextPageReminder = [];
      return this.currentPageTxns;
    }

    const currentNextReminder = structuredClone(this.nextPageReminder);

    /* 1. New txns loading is not needed, all persisted in the reminder */

    // new page consists fully from nextPageReminder
    if (currentNextReminder.length >= this.pageSize) {
      const resultTxns = currentNextReminder.slice(0, this.pageSize);
      this.nextPageReminder = currentNextReminder.slice(this.pageSize);
      this.prevPageReminder = this.getPrevPageReminderOnShowNextPage(resultTxns);
      this.currentPageTxns = resultTxns; // set new currentPageTxns only after calling getPrevPageReminderOnShowNextPage

      this.firstPage = false;
      this.page++;
      this.lastPage = await this.checkIsLastPage(addresses);

      return resultTxns;
    }

    /* 2. Loading new txns to get a full list */
    const lackTxnsCount = this.pageSize - currentNextReminder.length;
    const block = parseInt(this.currentPageTxns[this.currentPageTxns.length - 1][0].blockNumber);

    const result = await Promise.all(
      addresses.map(async (address) => {
        return txnsWithBlockDetailsToTxnsList(
          await getTransactionsBeforeWithBlockDetails(this.prov, address, block, lackTxnsCount)
        );
      })
    );

    const newTxns = removeTxnsListItemsDuplicates(result.flat())

    newTxns.sort((a, b) => {
      if (a[0].timestamp === '-') return 1;
      if (b[0].timestamp === '-') return -1;
      return Number(b[0].timestamp) - Number(a[0].timestamp);
    });

    const fullList = currentNextReminder.concat(newTxns);
    const resultTxns = fullList.slice(0, this.pageSize);
    const reminder = fullList.slice(this.pageSize);

    const lastTxnBlockResult = resultTxns[resultTxns.length - 1][0].blockNumber;
    this.nextPageReminder = reminder.filter((txn) => txn[0].blockNumber === lastTxnBlockResult);

    this.prevPageReminder = this.getPrevPageReminderOnShowNextPage(resultTxns);
    this.currentPageTxns = resultTxns; // set new currentPageTxns only after calling getPrevPageReminderOnShowNextPage

    this.firstPage = false;
    this.page++;
    this.lastPage = await this.checkIsLastPage(addresses);

    return resultTxns;
  }

  private getPrevPageReminderOnShowNextPage(
    newPageTxns: TransactionListItem[][]
  ): TransactionListItem[][] {
    const firstTxnResult = newPageTxns[0];
    const newPrevPageReminder = this.currentPageTxns.filter((txns) => {
      return txns[0].blockNumber === firstTxnResult[0].blockNumber;
    });
    if (
      this.prevPageReminder.length &&
      newPrevPageReminder.length &&
      this.prevPageReminder[0][0].blockNumber === newPrevPageReminder[0][0].blockNumber
    ) {
      return this.prevPageReminder.concat(newPrevPageReminder);
    } else {
      return newPrevPageReminder;
    }
  }

  async showLastPage(addresses: string[]): Promise<TransactionListItem[][]> {
    this.clear();

    const addressesLastPage = await Promise.all(
      addresses.map(async (address) => {
        return txnsWithBlockDetailsToTxnsList(
          await getTransactionsAfterWithBlockDetails(this.prov, address, 0, this.pageSize)
        );
      })
    );

    const allTxns = removeTxnsListItemsDuplicates(addressesLastPage.flat())
    allTxns.sort((a, b) => {
      if (a[0].timestamp === '-') return 1;
      if (b[0].timestamp === '-') return -1;
      return Number(b[0].timestamp) - Number(a[0].timestamp);
    });

    const resultStartPos = allTxns.length - this.pageSize;

    this.nextPageReminder = [];
    if (resultStartPos > 0) {
      this.currentPageTxns = allTxns.slice(resultStartPos);
      const reminder = allTxns.slice(0, resultStartPos);
      const firstTxnBlock = this.currentPageTxns[0][0].blockNumber;
      this.prevPageReminder = reminder.filter((txn) => txn[0].blockNumber === firstTxnBlock);
    } else {
      this.currentPageTxns = allTxns;
      this.prevPageReminder = [];
    }

    this.lastTxnHash = this.currentPageTxns[this.currentPageTxns.length - 1][0].hash;

    this.page = -1;
    this.firstPage = await this.checkIsFirstPage(addresses);
    this.lastPage = true;

    return this.currentPageTxns;
  }

  private async checkIsFirstPage(addresses: string[]): Promise<boolean> {
    if (this.page === 1) {
      return true;
    }

    if (this.firstTxnHash === this.currentPageTxns[0][0].hash) {
      return true;
    }

    if (this.currentPageTxns.length < this.pageSize) {
      return true;
    }

    if (this.currentPageTxns.length === this.pageSize && this.prevPageReminder.length === 0) {
      return !(await this.hasMoreTxnsAfterAddresses(addresses));
    }

    return false;
  }

  private hasMoreTxnsAfterAddresses = async (addresses: string[]): Promise<boolean> => {
    const addressesHasMoreTxns = await Promise.all(
      addresses.map(async (address) => {
        return await this.hasMoreTxnsAfter(address);
      })
    );
    return addressesHasMoreTxns.some((hasMore) => hasMore);
  };

  private hasMoreTxnsAfter = async (address: string): Promise<boolean> => {
    const firstTxnBlock = parseInt(this.currentPageTxns[0][0].blockNumber);
    const txnsCountToLoad = 1;
    const moreTxns = await getTransactionsAfterWithBlockDetails(
      this.prov,
      address,
      firstTxnBlock,
      txnsCountToLoad
    );
    return moreTxns.length > 0;
  };

  async showPrevPage(addresses: string[]): Promise<TransactionListItem[][]> {
    if (this.firstPage) {
      this.prevPageReminder = [];
      return this.currentPageTxns;
    }

    const currentBeforeReminder = structuredClone(this.prevPageReminder);

    /* 1. New txns loading is not needed, all persisted in the reminder */

    // new page consists fully from prevPageReminder
    if (currentBeforeReminder.length >= this.pageSize) {
      const resultStartPos = currentBeforeReminder.length - this.pageSize;
      const resultTxns = currentBeforeReminder.slice(resultStartPos);
      this.prevPageReminder = currentBeforeReminder.slice(0, resultStartPos);
      this.nextPageReminder = this.getNextPageReminderOnShowPrevPage(resultTxns);
      this.currentPageTxns = resultTxns; // set new currentPageTxns only after calling getNextPageReminderOnShowPrevPage

      this.page--;
      this.firstPage = await this.checkIsFirstPage(addresses);
      this.lastPage = false;

      return resultTxns;
    }

    /* 2. Loading new txns to get a full list */

    const lackTxnsCount = this.pageSize - currentBeforeReminder.length;
    const block = parseInt(this.currentPageTxns[0][0].blockNumber);

    const result = await Promise.all(
      addresses.map(async (address) => {
        return txnsWithBlockDetailsToTxnsList(
          await getTransactionsAfterWithBlockDetails(this.prov, address, block, lackTxnsCount)
        );
      })
    );

    const newTxns = removeTxnsListItemsDuplicates(result.flat())
    newTxns.sort((a, b) => {
      if (a[0].timestamp === '-') return 1;
      if (b[0].timestamp === '-') return -1;
      return Number(b[0].timestamp) - Number(a[0].timestamp);
    });

    let resultTxns: TransactionListItem[][];
    const fullList = newTxns.concat(currentBeforeReminder);
    const resultStartPos = fullList.length - this.pageSize;
    if (resultStartPos > 0) {
      resultTxns = fullList.slice(resultStartPos);
      const reminder = fullList.slice(0, resultStartPos);
      const firstTxnBlockResult = resultTxns[0][0].blockNumber;
      this.prevPageReminder = reminder.filter((txn) => txn[0].blockNumber === firstTxnBlockResult);
    } else {
      resultTxns = fullList;
      this.prevPageReminder = [];
    }

    this.nextPageReminder = this.getNextPageReminderOnShowPrevPage(resultTxns);
    this.currentPageTxns = resultTxns; // set new currentPageTxns only after calling getNextPageReminderOnShowPrevPage

    this.page--;
    this.firstPage = await this.checkIsFirstPage(addresses);
    this.lastPage = false;

    return resultTxns;
  }

  private getNextPageReminderOnShowPrevPage(
    newPageTxns: TransactionListItem[][]
  ): TransactionListItem[][] {
    const lastTxnResult = newPageTxns[newPageTxns.length - 1];
    const newNextPageReminder = this.currentPageTxns.filter((txns) => {
      return txns[0].blockNumber === lastTxnResult[0].blockNumber;
    });
    if (
      this.nextPageReminder.length &&
      newNextPageReminder.length === this.pageSize && // add this check to another same cases in pagination classes and test those well
      this.nextPageReminder[0][0].blockNumber === newNextPageReminder[0][0].blockNumber
    ) {
      return newNextPageReminder.concat(this.nextPageReminder);
    } else {
      return newNextPageReminder;
    }
  }
}
