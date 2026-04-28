'use client';

import { useEffect, useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LineChart, TrendingUp } from 'lucide-react';

export default function ForecastPage() {
  const [forecast, setForecast] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchForecast() {
      try {
        const res = await fetch('http://127.0.0.1:5000/forecast');
        const data = await res.json();
        setForecast(data || []);
      } catch (e) {
        console.error(e);
      } finally {
        setIsLoading(false);
      }
    }
    fetchForecast();
  }, []);

  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">Inventory Forecast</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Projected inbound shipments and inventory levels based on active ETAs.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
           <Card className="border-border shadow-sm bg-primary/5">
             <CardHeader className="py-4">
               <CardTitle className="text-sm font-semibold text-primary flex items-center gap-2">
                 <TrendingUp className="w-4 h-4" />
                 Total Projected Cartons
               </CardTitle>
             </CardHeader>
             <CardContent>
               <div className="text-3xl font-black text-primary">
                 {forecast.reduce((sum, item) => sum + item.cartons, 0).toLocaleString()}
               </div>
             </CardContent>
           </Card>
           <Card className="border-border shadow-sm">
             <CardHeader className="py-4">
               <CardTitle className="text-sm font-semibold text-muted-foreground">
                 Total Projected Units
               </CardTitle>
             </CardHeader>
             <CardContent>
               <div className="text-3xl font-black text-slate-800">
                 {forecast.reduce((sum, item) => sum + item.units, 0).toLocaleString()}
               </div>
             </CardContent>
           </Card>
        </div>

        <Card className="border-border shadow-sm overflow-hidden">
          <CardHeader className="bg-slate-50/50 border-b border-border py-4">
            <div className="flex items-center gap-2">
              <LineChart className="w-5 h-5 text-indigo-600" />
              <CardTitle className="text-base font-bold">Inbound Weekly Forecast</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30">
                  <TableHead className="font-bold text-slate-700 h-12">Arriving Week</TableHead>
                  <TableHead className="font-bold text-slate-700 text-right h-12">Incoming Cartons</TableHead>
                  <TableHead className="font-bold text-slate-700 text-right h-12">Incoming Units</TableHead>
                  <TableHead className="font-bold text-slate-700 h-12">Warehouse Breakdown (Units)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={4} className="text-center py-12 text-muted-foreground">
                    <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 opacity-20" />
                    Calculating weekly forecast...
                  </TableCell></TableRow>
                ) : forecast.length === 0 ? (
                  <TableRow><TableCell colSpan={4} className="text-center py-12 text-muted-foreground italic">No active inbound shipments found in the pipeline.</TableCell></TableRow>
                ) : (
                  forecast.map((f, i) => (
                    <TableRow key={i} className="hover:bg-muted/30 transition-colors">
                      <TableCell className="font-bold text-slate-900 py-4">
                        <Badge variant="outline" className="mr-2 bg-indigo-50 text-indigo-700 border-indigo-200">
                          {f.week}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-medium text-slate-600 py-4">{f.cartons.toLocaleString()}</TableCell>
                      <TableCell className="text-right text-indigo-600 font-bold text-lg py-4">{f.units.toLocaleString()}</TableCell>
                      <TableCell className="py-4">
                        <div className="flex flex-wrap gap-2">
                          {Object.entries(f.warehouses || {}).map(([wh, qty]: any) => (
                            <div key={wh} className="text-[10px] bg-slate-100 px-2 py-0.5 rounded border border-slate-200 flex flex-col">
                              <span className="font-bold uppercase opacity-60 tracking-tighter">{wh}</span>
                              <span className="text-xs font-bold text-slate-800">{(qty as number).toLocaleString()}</span>
                            </div>
                          ))}
                        </div>
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
