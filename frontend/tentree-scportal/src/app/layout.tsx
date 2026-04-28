import type { Metadata } from "next";
import { Inter, Geist } from "next/font/google";
import "./globals.css";
import AppLayout from "@/components/layout/AppLayout";
import { Toaster } from "sonner";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Base44 APP",
  description: "App migrated to Next.js",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={cn("font-sans", geist.variable)}>
      <body className={`${inter.variable} antialiased`}>
        <AppLayout>
          {children}
        </AppLayout>
        <Toaster />
      </body>
    </html>
  );
}
