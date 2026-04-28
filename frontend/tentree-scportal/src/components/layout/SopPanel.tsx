'use client';

import React, { useState, useEffect } from 'react';
import { ChevronRight, FileText, Info, Pencil, Save, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export default function SopPanel({ title, isOpen, onToggle }: any) {
  const [isEditing, setIsEditing] = useState(false);
  const [content, setContent] = useState('');
  const storageKey = `sop_${title?.replace(/\s+/g, '_').toLowerCase()}`;

  // Load saved SOP from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      setContent(saved);
    }
  }, [storageKey]);

  const handleSave = () => {
    localStorage.setItem(storageKey, content);
    setIsEditing(false);
  };

  const handleCancel = () => {
    const saved = localStorage.getItem(storageKey);
    setContent(saved || '');
    setIsEditing(false);
  };

  return (
    <div 
      className={cn(
        "flex-shrink-0 bg-card transition-all duration-300 ease-in-out h-full relative border-l border-border",
        isOpen ? "w-[360px]" : "w-0 border-l-0"
      )}
    >
      {/* Toggle Button that hangs off the edge */}
      <button
        onClick={onToggle}
        className={cn(
          "absolute top-6 -left-4 w-8 h-8 bg-background border border-border rounded-full flex items-center justify-center shadow-md text-muted-foreground hover:text-primary hover:border-primary transition-colors z-20",
          !isOpen && "-left-12 top-4 w-10 h-10 shadow-lg bg-primary text-primary-foreground border-transparent hover:text-primary-foreground hover:bg-primary/90"
        )}
        title={isOpen ? "Close SOP Panel" : "Open SOP Panel"}
      >
        {isOpen ? (
          <ChevronRight className="w-4 h-4" />
        ) : (
          <Info className="w-5 h-5" />
        )}
      </button>

      {/* Panel Content wrapper */}
      <div className="w-[360px] h-full flex flex-col absolute top-0 left-0 bg-card overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-border bg-muted/20">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
              <FileText className="w-4 h-4" />
            </div>
            <h3 className="font-semibold text-foreground truncate">{title || 'Standard Operating Procedure'}</h3>
          </div>
          
          {!isEditing && (
            <Button variant="ghost" size="icon" onClick={() => setIsEditing(true)} className="h-8 w-8 text-muted-foreground hover:text-primary">
              <Pencil className="w-4 h-4" />
            </Button>
          )}
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-5 flex flex-col">
          {isEditing ? (
            <div className="flex flex-col h-full space-y-3">
              <Textarea 
                value={content}
                onChange={(e: any) => setContent(e.target.value)}
                placeholder="Write your standard operating procedures here..."
                className="flex-1 resize-none bg-background focus-visible:ring-1"
              />
              <div className="flex items-center justify-end gap-2 pt-2">
                <Button variant="outline" size="sm" onClick={handleCancel}>
                  <X className="w-4 h-4 mr-1" /> Cancel
                </Button>
                <Button size="sm" onClick={handleSave}>
                  <Save className="w-4 h-4 mr-1" /> Save
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {content ? (
                <div className="text-sm leading-relaxed text-muted-foreground whitespace-pre-wrap">
                  {content}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground text-center py-10 flex flex-col items-center gap-3">
                  <FileText className="w-8 h-8 text-muted/30" />
                  <p>No SOP written yet.</p>
                  <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
                    Click here to add instructions
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}