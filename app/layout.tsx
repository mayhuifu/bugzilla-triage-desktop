import type { Metadata } from "next";
import "./globals.css";
import { ToastContainer } from "@/components/ui/Toast";

export const metadata: Metadata = {
  title: "Bugzilla AI Triage Dashboard",
  description: "AI-assisted bug triage workflow with human approval and Bugzilla integration via MCP.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <div className="min-h-screen relative">
          <div
            className="absolute inset-0 -z-10 opacity-40"
            style={{
              backgroundImage:
                "radial-gradient(at 20% 0%, rgba(59,130,246,0.18), transparent 50%), radial-gradient(at 80% 100%, rgba(168,85,247,0.12), transparent 50%)",
            }}
          />
          {children}
          <ToastContainer />
        </div>
      </body>
    </html>
  );
}
