import type { Metadata } from "next";
import { Inter, Geist } from "next/font/google";
import { cookies } from "next/headers";
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
  const [user, cookieStore] = await Promise.all([getSession(), cookies()]);
  // Theme is rendered server-side from the cookie so the saved theme is in the
  // initial HTML — no flash of the default (red) theme, and no client-side script.
  const themeSummer = cookieStore.get('portal-theme')?.value === 'summer';

  return (
    <html lang="en" className={cn("font-sans", geist.variable, themeSummer && "theme-summer")} suppressHydrationWarning>
      <body className={`${inter.variable} antialiased`}>
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
