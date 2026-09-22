import type { Metadata } from "next";
import { Inter, Geist } from "next/font/google";
import { cookies } from "next/headers";
import "./globals.css";
import AppLayout from "@/components/layout/AppLayout";
import { SessionProvider } from "@/components/providers/SessionProvider";
import { getSession, getAuthToken } from "@/app/actions/auth";
import { fetchIdentity } from "@/lib/serverIdentity";
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
  const [user, cookieStore, token] = await Promise.all([getSession(), cookies(), getAuthToken()]);
  // Theme is rendered server-side from the cookie so the saved theme is in the
  // initial HTML — no flash of the default (red) theme, and no client-side script.
  const themeSummer = cookieStore.get('portal-theme')?.value === 'summer';

  // The session cookie's permissions[] were frozen at login, so revoking one left
  // the nav item on screen (and, before the route gate, the page reachable) until
  // that user logged out and back in. Re-resolve them per render from the server,
  // which is the same answer the gate enforces — nav and gate can't disagree.
  //
  // Identity comes from the TOKEN, not the cookie, so it is also what fills in when
  // the `session` cookie is missing or unparseable but auth_token is valid. That
  // case used to hand the Sidebar `null`, whose can() then answered "yes" to
  // everything and drew the whole menu.
  const identity = token ? await fetchIdentity(token) : null;
  const sessionUser = identity?.ok
    ? {
        ...(user ?? {}),
        id: identity.identity.id,
        email: identity.identity.email,
        role: identity.identity.role,
        name: user?.name ?? identity.identity.name ?? identity.identity.email,
        supplier: user?.supplier ?? identity.identity.supplier ?? undefined,
        permissions: identity.identity.permissions,
      }
    : user;

  return (
    <html lang="en" className={cn("font-sans", geist.variable, themeSummer && "theme-summer")} suppressHydrationWarning>
      <body className={`${inter.variable} antialiased`}>
        <SessionProvider initialUser={sessionUser}>
          <AppLayout>
            {children}
          </AppLayout>
          <Toaster />
        </SessionProvider>
      </body>
    </html>
  );
}
