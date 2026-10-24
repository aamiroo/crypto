import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Crypto Terminal",
  description: "Professional real-time crypto trading terminal — Bybit",
  icons: { icon: "data:," },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the theme store rewrites data-theme/class on
    // <html> client-side (localStorage / prefers-color-scheme) which can land
    // before React hydrates — a classic false-positive mismatch.
    <html lang="en" data-theme="dark" className="dark" suppressHydrationWarning>
      <body className="antialiased">{children}</body>
    </html>
  );
}
