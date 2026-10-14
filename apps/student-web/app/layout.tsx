import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Header } from "@/components/header";
import { OfflineBanner } from "@/components/offline-banner";
import { Providers } from "@/lib/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "CampusCart", template: "%s · CampusCart" },
  description: "Order ahead, pick a pickup time, and skip the canteen queue.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2"
        >
          Skip to content
        </a>
        <Providers>
          <OfflineBanner />
          <Header />
          <main id="main" className="mx-auto max-w-5xl px-4 pb-24 pt-6">
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}
