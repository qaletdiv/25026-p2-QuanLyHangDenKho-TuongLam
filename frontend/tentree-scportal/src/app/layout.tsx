import type { Metadata } from "next";
import { Inter, Geist } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import AppLayout from "@/components/layout/AppLayout";
import { SessionProvider } from "@/components/providers/SessionProvider";
import { getSession } from "@/app/actions/auth";
import { Toaster } from "sonner";
import { cn } from "@/lib/utils";

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "tentree Supply Chain Portal",
  description: "Supply Chain Portal for tentree",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await getSession();

  return (
    <html lang="en" className={cn("font-sans", geist.variable)} suppressHydrationWarning>
      <body className={`${inter.variable} antialiased`}>
        {/* Apply the saved theme before hydration to avoid a flash (next/script,
            beforeInteractive — must live in the root layout; id required for inline). */}
        <Script id="theme-init" strategy="beforeInteractive" dangerouslySetInnerHTML={{
          __html: `(function(){try{var t=localStorage.getItem('portal-theme');if(t==='summer')document.documentElement.classList.add('theme-summer');}catch(e){}})();`,
        }} />
        <SessionProvider initialUser={user}>
          <AppLayout>
            {children}
          </AppLayout>
          <Toaster />
        </SessionProvider>
      </body>
    </html>
  );
}
