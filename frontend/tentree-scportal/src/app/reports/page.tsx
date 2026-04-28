'use client';

import { useEffect, useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BarChart3 } from 'lucide-react';

export default function ReportsPage() {
  const [reports, setReports] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchReports() {
      try {
        const res = await fetch('http://127.0.0.1:5000/reports');
        const data = await res.json();
        setReports(data || []);
      } catch (e) {
        console.error(e);
      } finally {
        setIsLoading(false);
      }
    }
    fetchReports();
  }, []);

  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">Reports</h1>
            <p className="text-sm text-muted-foreground mt-1">
              PO tracking, received quantities, freight, and duty summaries.
            </p>
          </div>
        </div>

        <Card className="border-border shadow-sm overflow-hidden">
          <CardHeader className="bg-slate-50/50 border-b border-border py-4">
            <div className="flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-indigo-600" />
              <CardTitle className="text-base font-bold text-slate-800">Discrepancy & Value Report</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30">
                  <TableHead className="font-bold text-slate-700 h-11">PO #</TableHead>
                  <TableHead className="font-bold text-slate-700 h-11">Supplier</TableHead>
                  <TableHead className="font-bold text-slate-700 text-right h-11">Expected</TableHead>
                  <TableHead className="font-bold text-slate-700 text-right h-11">Received</TableHead>
                  <TableHead className="font-bold text-slate-700 text-right h-11">Discrepancy</TableHead>
                  <TableHead className="font-bold text-slate-700 text-right h-11">Total Cost ($)</TableHead>
                  <TableHead className="font-bold text-slate-700 h-11">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-12 text-muted-foreground italic">Generating report data...</TableCell></TableRow>
                ) : reports.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-12 text-muted-foreground italic">No shipment data available for reporting.</TableCell></TableRow>
                ) : (
                  reports.map((r, i) => (
                    <TableRow key={i} className="hover:bg-muted/30 transition-colors border-b border-border/40">
                      <TableCell className="font-mono text-xs font-bold text-indigo-600 py-3">{r.po_number || '—'}</TableCell>
                      <TableCell className="text-sm py-3 truncate max-w-[150px]">{r.supplier || '—'}</TableCell>
                      <TableCell className="text-right text-sm font-medium text-slate-500 py-3">{r.expected_units?.toLocaleString()}</TableCell>
                      <TableCell className="text-right text-sm font-bold text-slate-900 py-3">{r.received_units?.toLocaleString()}</TableCell>
                      <TableCell className={cn(
                        "text-right text-sm font-black py-3",
                        r.discrepancy < 0 ? "text-destructive" : r.discrepancy > 0 ? "text-emerald-600" : "text-slate-400"
                      )}>
                        {r.discrepancy > 0 ? `+${r.discrepancy}` : r.discrepancy}
                      </TableCell>
                      <TableCell className="text-right font-bold text-slate-900 py-3">
                        ${r.total_cost?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </TableCell>
                      <TableCell className="py-3">
                        <Badge variant="outline" className={cn(
                          "text-[10px] font-bold px-2 py-0",
                          r.status === 'Delivered' ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-blue-50 text-blue-700 border-blue-200"
                        )}>
                          {r.status || 'Active'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
