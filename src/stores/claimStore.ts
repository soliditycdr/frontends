import { readItem } from "squirrel-gill/lib/storage"
import { create } from "zustand"
import { persist } from "zustand/middleware"

import { fetchTxByHashUrl } from "@/apis/bridge"
import { CLAIM_TRANSACTIONS } from "@/constants/storageKey"
import { BRIDGE_TRANSACTIONS } from "@/constants/storageKey"
import { TimestampTx, TxDirection } from "@/stores/txStore"

interface TxStore {
  page: number
  total: number
  loading: boolean
  claimLoading: boolean
  txStatus: ClaimStatus
  targetTransaction: string | null
  pageTransactions: Transaction[]
  orderedTxDB: TimestampTx[]
  comboPageTransactions: (walletAddress, page, rowsPerPage) => Promise<any>
  generateTransactions: (transactions) => void
  setTargetTransaction: (address) => void
  clearTransactions: () => void
}

export const enum ClaimStatus {
  // Batch not finalized
  NOT_READY = 1,
  CLAIMABLE = 2,
  CLAIMING = 3,
  CLAIMED = 4,
  FAILED = 5,
}

interface Transaction {
  hash: string
  toHash?: string
  fromBlockNumber?: number
  toBlockNumber?: number
  amount: string
  isL1: boolean
  symbolToken?: string
  timestamp?: number
  claimInfo?: object
  assumedStatus?: string
  errMsg?: string
  initiatedAt?: string
  finalisedAt?: string
  loading?: boolean
}

const MAX_OFFSET_TIME = 30 * 60 * 1000

export const isValidOffsetTime = offsetTime => offsetTime < MAX_OFFSET_TIME

const formatTxList = async backList => {
  if (!backList.length) {
    return { txList: [] }
  }

  const txList = backList.map(tx => {
    const amount = tx.amount
    const toHash = tx.finalizeTx?.hash
    const initiatedAt = tx.blockTimestamp || tx.createdTime
    const finalisedAt = tx.finalizeTx?.blockTimestamp

    return {
      hash: tx.hash,
      amount,
      fromBlockNumber: tx.blockNumber,
      toHash,
      toBlockNumber: tx.finalizeTx?.blockNumber,
      isL1: tx.isL1,
      symbolToken: tx.isL1 ? tx.l1Token : tx.l2Token,
      claimInfo: tx.claimInfo,
      initiatedAt,
      finalisedAt,
    }
  })

  return {
    txList,
  }
}

const detailOrderdTxs = async (pageOrderedTxs, frontTransactions, abnormalTransactions) => {
  const needFetchTxs = pageOrderedTxs.map(item => item.hash)

  let historyList: Transaction[] = []
  if (needFetchTxs.length) {
    const { data } = await scrollRequest(fetchTxByHashUrl, {
      method: "post",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ txs: needFetchTxs }),
    })
    const { txList } = await formatTxList(data.result)
    historyList = txList
  }
  const allTransactions = [...historyList, ...abnormalTransactions, ...frontTransactions]

  const pageTransactions = pageOrderedTxs
    .map(({ hash, position }) => {
      return allTransactions.find(item => item.hash === hash)
    })
    .filter(item => item) // TODO: fot test
  return { pageTransactions }
}

const useTxStore = create<TxStore>()(
  persist(
    (set, get) => ({
      page: 1,
      total: 0,
      loading: false,
      claimLoading: false,
      txStatus: 1,
      pageTransactions: [],
      orderedTxDB: [],
      targetTransaction: null,
      // polling transactions
      // slim frontTransactions and keep the latest 3 backTransactions
      generateTransactions: async historyList => {
        const { pageTransactions } = get()

        const realHistoryList = historyList.filter(item => item)

        if (realHistoryList.length) {
          const { txList: formattedHistoryList } = await formatTxList(realHistoryList)
          const formattedHistoryListMap = Object.fromEntries(formattedHistoryList.map(item => [item.hash, item]))

          const refreshPageTransaction = pageTransactions.map(item => {
            if (formattedHistoryListMap[item.hash]) {
              return formattedHistoryListMap[item.hash]
            }
            return item
          })

          set({
            pageTransactions: refreshPageTransaction,
          })
        }
      },
      comboPageTransactions: async (address, page, rowsPerPage) => {
        const { state } = readItem(localStorage, BRIDGE_TRANSACTIONS)
        const { orderedTxDB, frontTransactions, abnormalTransactions } = state

        const orderedTxs = orderedTxDB[address] ?? []
        set({ loading: true })
        const withdrawTx = orderedTxs.filter(tx => tx.direction === TxDirection.Withdraw)
        const pageOrderedTxs = withdrawTx.slice((page - 1) * rowsPerPage, page * rowsPerPage)
        const { pageTransactions } = await detailOrderdTxs(pageOrderedTxs, frontTransactions, abnormalTransactions)
        set({
          orderedTxDB: withdrawTx,
          pageTransactions,
          page,
          total: withdrawTx.length,
          loading: false,
        })
      },
      setTargetTransaction: address => {
        set({
          targetTransaction: address,
        })
      },
      clearTransactions: () => {
        set({
          pageTransactions: [],
          page: 1,
          total: 0,
        })
      },
    }),
    {
      name: CLAIM_TRANSACTIONS,
    },
  ),
)

export default useTxStore
