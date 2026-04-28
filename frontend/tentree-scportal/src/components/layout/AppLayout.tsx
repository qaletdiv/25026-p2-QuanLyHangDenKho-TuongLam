import React from 'react';
import Sidebar from './Sidebar';
import Header from './Header';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen w-full bg-background overflow-hidden font-sans">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Header />
        <main className="flex-1 overflow-auto bg-muted/10 relative">
          {children}
        </main>
      </div>
    </div>
  );
}