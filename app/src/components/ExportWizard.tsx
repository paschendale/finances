import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as XLSX from 'xlsx';
import { fetchTransactionsForExport, fetchAccounts, fetchAccountsTree, type Transaction, type AccountNode } from '@/lib/api';
import { MultiSearchableSelect } from './MultiSearchableSelect';
import { Calendar, Download, X, Loader2, FileText, Table2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LedgerFilters } from './LedgerFilterBar';

interface ExportWizardProps {
  onClose: () => void;
  initialFilters?: LedgerFilters;
}

function exportData(transactions: Transaction[], format: 'csv' | 'xlsx', startDate: string, endDate: string, accountTree: AccountNode[]) {
  const fullNameMap = new Map(accountTree.map(a => [a.id, a.full_name]));
  const rows = transactions.flatMap(t =>
    t.entries.map(e => ({
      Date: t.date,
      Description: t.description,
      Account: fullNameMap.get(e.account_id) ?? e.account_name,
      Amount: e.amount,
      Currency: e.currency,
      'Exchange Rate': e.exchange_rate,
      'Amount (Base)': e.amount_base,
    }))
  );
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Transactions');
  const datePart = [startDate, endDate].filter(Boolean).join('_');
  const filename = datePart ? `export_${datePart}.${format}` : `export.${format}`;
  XLSX.writeFile(wb, filename, { bookType: format });
}

export function ExportWizard({ onClose, initialFilters }: ExportWizardProps) {
  const [startDate, setStartDate] = useState(initialFilters?.startDate || '');
  const [endDate, setEndDate] = useState(initialFilters?.endDate || '');
  const [accountIds, setAccountIds] = useState<string[]>(initialFilters?.accountIds || []);
  const [format, setFormat] = useState<'csv' | 'xlsx'>('csv');

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
  });

  const { data: accountTree = [] } = useQuery({
    queryKey: ['accountsTree'],
    queryFn: fetchAccountsTree,
  });

  const accountOptions = useMemo(() =>
    accounts.filter(a => !a.hidden).map(a => ({ label: a.account_name, value: a.account_id, icon: a.icon, color: a.color })),
  [accounts]);

  const { data: transactions = [], isLoading } = useQuery({
    queryKey: ['exportTransactions', startDate, endDate, accountIds],
    queryFn: () => fetchTransactionsForExport(startDate || undefined, endDate || undefined, accountIds.length > 0 ? accountIds : undefined),
  });

  const fullNameMap = useMemo(() => new Map(accountTree.map(a => [a.id, a.full_name])), [accountTree]);

  const allEntries = useMemo(() =>
    transactions.flatMap(t => t.entries.map(e => ({
      ...e,
      account_name: fullNameMap.get(e.account_id) ?? e.account_name,
      date: t.date,
      description: t.description,
    }))),
  [transactions, fullNameMap]);

  const previewRows = allEntries.slice(0, 50);

  return (
    <div className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-md flex items-center justify-center p-4">
      <div className="w-full max-w-3xl bg-[#111] border border-white/[0.08] rounded-2xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-3">
            <Download className="w-4 h-4 text-white/50" />
            <h2 className="text-[15px] font-bold tracking-tight">Export</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/[0.06] text-white/40 hover:text-white/80 transition-all"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Filters */}
        <div className="px-6 py-4 border-b border-white/[0.06] flex flex-wrap gap-4 items-end">
          {/* Account filter */}
          <div className="flex-1 min-w-[220px]">
            <label className="block text-[10px] font-bold uppercase tracking-widest text-white/30 mb-1.5">Accounts</label>
            <MultiSearchableSelect
              options={accountOptions}
              values={accountIds}
              onChange={setAccountIds}
              placeholder="All accounts..."
            />
          </div>

          {/* Date range */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] font-bold uppercase tracking-widest text-white/30">Date Range</label>
            <div className="flex items-center gap-2 bg-white/[0.03] border border-white/10 rounded-xl px-2.5 py-1.5 backdrop-blur-md">
              <Calendar className="w-3 h-3 text-white/30 shrink-0" />
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="bg-transparent border-none p-0 focus:ring-0 text-[11px] text-white/70 w-24 uppercase font-mono"
              />
              <span className="text-white/10 text-[10px]">→</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="bg-transparent border-none p-0 focus:ring-0 text-[11px] text-white/70 w-24 uppercase font-mono"
              />
            </div>
          </div>

          {/* Format toggle */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] font-bold uppercase tracking-widest text-white/30">Format</label>
            <div className="flex rounded-xl border border-white/10 overflow-hidden">
              <button
                onClick={() => setFormat('csv')}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-bold transition-all",
                  format === 'csv' ? "bg-white/10 text-white" : "bg-white/[0.02] text-white/40 hover:text-white/70"
                )}
              >
                <FileText className="w-3 h-3" /> CSV
              </button>
              <button
                onClick={() => setFormat('xlsx')}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-bold transition-all",
                  format === 'xlsx' ? "bg-white/10 text-white" : "bg-white/[0.02] text-white/40 hover:text-white/70"
                )}
              >
                <Table2 className="w-3 h-3" /> XLSX
              </button>
            </div>
          </div>
        </div>

        {/* Preview table */}
        <div className="flex-1 overflow-auto px-6 py-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-white/30">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              <span className="text-[13px]">Loading...</span>
            </div>
          ) : allEntries.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-white/20 text-[13px]">
              No entries match the current filters
            </div>
          ) : (
            <>
              {allEntries.length > 50 && (
                <p className="text-[11px] text-white/30 mb-3 font-mono">
                  Showing first 50 of {allEntries.length} entries
                </p>
              )}
              <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                      {['Date', 'Description', 'Account', 'Amount', 'Currency', 'Exch. Rate', 'Amount (Base)'].map(h => (
                        <th key={h} className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-widest text-white/30 whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((row, i) => (
                      <tr key={i} className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors">
                        <td className="px-3 py-1.5 font-mono text-white/50 whitespace-nowrap">{row.date}</td>
                        <td className="px-3 py-1.5 text-white/70 max-w-[180px] truncate">{row.description}</td>
                        <td className="px-3 py-1.5 text-white/60 font-mono whitespace-nowrap">{row.account_name}</td>
                        <td className={cn(
                          "px-3 py-1.5 font-mono text-right whitespace-nowrap",
                          row.amount < 0 ? "text-red-400/70" : "text-green-400/70"
                        )}>
                          {row.amount.toFixed(2)}
                        </td>
                        <td className="px-3 py-1.5 text-white/40 font-mono">{row.currency}</td>
                        <td className="px-3 py-1.5 text-white/40 font-mono text-right">{row.exchange_rate}</td>
                        <td className={cn(
                          "px-3 py-1.5 font-mono text-right whitespace-nowrap",
                          row.amount_base < 0 ? "text-red-400/70" : "text-green-400/70"
                        )}>
                          {row.amount_base.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-white/[0.06] bg-white/[0.01]">
          <span className="text-[12px] text-white/30 font-mono">
            {allEntries.length} entries across {transactions.length} transactions
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-[12px] font-bold text-white/40 hover:text-white/70 hover:bg-white/[0.05] transition-all"
            >
              Cancel
            </button>
            <button
              onClick={() => exportData(transactions, format, startDate, endDate, accountTree)}
              disabled={transactions.length === 0 || isLoading}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-xl text-[12px] font-bold transition-all",
                transactions.length > 0 && !isLoading
                  ? "bg-white text-black hover:bg-white/90 active:scale-95"
                  : "bg-white/10 text-white/30 cursor-not-allowed"
              )}
            >
              <Download className="w-3.5 h-3.5" />
              Export {format.toUpperCase()}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
