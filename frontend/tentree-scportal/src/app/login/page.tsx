'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { login } from '../actions/auth';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { Shield, Lock, Mail, ArrowRight, Loader2 } from 'lucide-react';

export default function LoginPage() {
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsLoading(true);

    const formData = new FormData(e.currentTarget);
    const data = Object.fromEntries(formData);

    const result = await login(data);

    if (result.error) {
      toast.error(result.error);
      setIsLoading(false);
    } else {
      toast.success('Welcome back!');
      router.push('/mainline/shipments');
      router.refresh();
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-[#F8FAFC] relative overflow-hidden">
      {/* Decorative Background Elements */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/5 rounded-full blur-[120px]" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-primary/10 rounded-full blur-[120px]" />

      <div className="w-full max-w-md p-6 relative z-10">
        {/* One surface: brand, form and footer share a single card so the page
            reads as one object rather than four stacked islands. */}
        <div className="bg-white rounded-3xl shadow-[0_20px_50px_rgba(0,0,0,0.06)] border border-slate-100 overflow-hidden animate-in fade-in slide-in-from-bottom-6 duration-700">
          <div className="px-8 pt-10 pb-8 text-center">
            <img
              src="/tentree_logo_green.png"
              alt="Tentree"
              className="h-14 w-auto object-contain mx-auto"
            />
            <h1 className="mt-5 text-2xl font-bold tracking-tight text-slate-900">Tentree Portal</h1>
            <p className="mt-1.5 text-sm text-slate-500 font-medium">Supply Chain Management System</p>
          </div>

          <div className="px-8 pb-8">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-sm font-semibold text-slate-700">Email Address</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input 
                  id="email" 
                  name="email" 
                  type="email" 
                  required 
                  placeholder="name@tentree.com" 
                  className="pl-10 h-12 bg-white border-slate-300 text-slate-900 placeholder:text-slate-400 focus:bg-white focus:border-primary transition-all rounded-xl"
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password" className="text-sm font-semibold text-slate-700">Password</Label>
                <a href="#" className="text-xs font-medium text-primary hover:underline">Forgot password?</a>
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  id="password"
                  name="password"
                  type="password"
                  required
                  placeholder="••••••••"
                  className="pl-10 h-12 bg-white border-slate-300 text-slate-900 placeholder:text-slate-400 focus:bg-white focus:border-primary transition-all rounded-xl"
                />
              </div>
            </div>

            <Button 
              type="submit" 
              disabled={isLoading}
              className="w-full h-12 rounded-xl text-base font-semibold shadow-lg shadow-primary/20 group"
            >
              {isLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <>
                  Sign In 
                  <ArrowRight className="w-4 h-4 ml-2 transition-transform group-hover:translate-x-1" />
                </>
              )}
            </Button>
          </form>
          </div>

          {/* Tinted footer rail — anchors the card's bottom edge and keeps the
              help + security lines attached to it instead of drifting below. */}
          <div className="bg-slate-50/80 border-t border-slate-100 px-8 py-5 space-y-2.5 text-center">
            <p className="text-sm text-slate-500">
              Need help?{' '}
              <span className="text-primary font-semibold cursor-pointer hover:underline">Contact IT Support</span>
            </p>
            <div className="flex items-center justify-center gap-1.5 text-[11px] font-medium tracking-wide text-slate-400">
              <Shield className="w-3 h-3" />
              SECURE ACCESS ONLY
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

