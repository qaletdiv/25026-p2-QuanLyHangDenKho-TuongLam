'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { createShipment } from '@/app/actions/shipments';
import { toast } from 'sonner';
import { X, UploadCloud, FileText, Check, AlertCircle, Loader2 } from 'lucide-react';
import Papa from 'papaparse';

export default function SmsImportModal({ open, onClose, onSuccess }: any) {
  const [data, setData] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  if (!open) return null;

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsLoading(true);
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        // Map common headers to our format
        const mappedData = results.data.map((row: any) => ({
          po_number: row['PO Number'] || row['PO'] || row['po_number'] || '',
          supplier: row['Supplier'] || row['supplier'] || '',
          destination_warehouse: row['Warehouse'] || row['warehouse'] || row['destination_warehouse'] || 'NRI CAN',
          courier: row['Courier'] || row['courier'] || 'FedEx',
          tracking_number: row['Tracking Number'] || row['Tracking'] || row['tracking_number'] || '',
          eta: row['ETA'] || row['eta'] || '',
          season: row['Season'] || row['season'] || '',
          incoterm: row['Incoterm'] || row['incoterm'] || 'DDP',
          type: 'sms',
          mode: row['Mode'] || row['mode'] || 'Courier',
          status: 'Ready to Ship',
          archived: false
        }));
        
        setData(mappedData);
        setIsLoading(false);
        toast.success(`Parsed ${mappedData.length} shipments from file`);
      },
      error: (error) => {
        console.error(error);
        toast.error('Failed to parse CSV file');
        setIsLoading(false);
      }
    });
  };

  const handleSave = async () => {
    if (data.length === 0) return;
    
    setIsSaving(true);
    let successCount = 0;
    
    try {
      for (const shipment of data) {
        if (!shipment.po_number) continue;
        await createShipment(shipment);
        successCount++;
      }
      
      toast.success(`Successfully imported ${successCount} shipments`);
      if (onSuccess) onSuccess();
      onClose();
    } catch (error) {
      console.error(error);
      toast.error('Error during bulk import. Some shipments may not have been saved.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-card w-full max-w-4xl rounded-xl shadow-2xl border border-border overflow-hidden flex flex-col max-h-[90vh] animate-in fade-in zoom-in-95 duration-200">
        
        <div className="flex items-center justify-between p-4 border-b border-border bg-muted/30">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <UploadCloud className="w-5 h-5 text-primary" />
            Bulk Import SMS Shipments
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose} disabled={isSaving}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="p-6 flex-1 overflow-y-auto space-y-6">
          {data.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 border-2 border-dashed border-muted-foreground/25 rounded-xl bg-muted/5 space-y-4">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                {isLoading ? <Loader2 className="w-8 h-8 text-primary animate-spin" /> : <FileText className="w-8 h-8 text-primary" />}
              </div>
              <div className="text-center">
                <p className="text-base font-medium">Upload your shipment CSV</p>
                <p className="text-sm text-muted-foreground mt-1">Expected columns: PO Number, Supplier, Warehouse, Courier, Tracking Number, Incoterm, ETA</p>
              </div>
              <div className="relative">
                <input 
                  type="file" 
                  accept=".csv" 
                  className="absolute inset-0 opacity-0 cursor-pointer" 
                  onChange={handleFileUpload}
                  disabled={isLoading}
                />
                <Button disabled={isLoading} className="gap-2">
                  <UploadCloud className="w-4 h-4" />
                  Select CSV File
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-muted-foreground">Previewing {data.length} shipments</p>
                <Button variant="outline" size="sm" onClick={() => setData([])} disabled={isSaving}>Clear & Restart</Button>
              </div>
              
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead>PO Number</TableHead>
                      <TableHead>Supplier</TableHead>
                      <TableHead>Courier</TableHead>
                      <TableHead>Tracking</TableHead>
                      <TableHead>Incoterm</TableHead>
                      <TableHead>Warehouse</TableHead>
                      <TableHead>ETA</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.map((row, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-medium">{row.po_number || <span className="text-destructive flex items-center gap-1"><AlertCircle className="w-3 h-3"/> Required</span>}</TableCell>
                        <TableCell>{row.supplier}</TableCell>
                        <TableCell>{row.courier}</TableCell>
                        <TableCell className="font-mono text-xs">{row.tracking_number}</TableCell>
                        <TableCell>{row.incoterm}</TableCell>
                        <TableCell>{row.destination_warehouse}</TableCell>
                        <TableCell>{row.eta}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-border bg-muted/30 flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {data.length > 0 && <span>Only rows with a PO Number will be imported.</span>}
          </div>
          <div className="flex gap-3">
            <Button variant="outline" onClick={onClose} disabled={isSaving}>Cancel</Button>
            <Button 
              onClick={handleSave} 
              disabled={data.length === 0 || isSaving} 
              className="gap-2 bg-primary min-w-[120px]"
            >
              {isSaving ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Saving...</>
              ) : (
                <><Check className="w-4 h-4" /> Import {data.length} Shipments</>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
