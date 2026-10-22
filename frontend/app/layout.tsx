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
      <head>
        {/* TEMP DIAGNOSTIC — remove */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "window.__errs=[];var __p=function(s){try{window.__errs.push(String(s));if(window.__errs.length>40)window.__errs.shift()}catch(e){}};" +
              "window.addEventListener('error',function(e){var d=e.error||{};__p('ERR type='+e.type+' tag='+(e.target&&e.target.tagName)+' src='+(e.target&&e.target.src||e.target&&e.target.href||'')+' name='+d.name+' msg='+d.message+' stack='+String(d.stack||'').split('\\n').slice(0,6).join(' << '))},true);" +
              "window.addEventListener('unhandledrejection',function(e){var d=e.reason||{};__p('REJ name='+d.name+' msg='+d.message+' stack='+String(d.stack||'').split('\\n').slice(0,6).join(' << '))},true);",
          }}
        />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
