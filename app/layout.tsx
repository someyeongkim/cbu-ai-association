import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CBU Artificial Intelligence Association",
  description: "Practical AI literacy for every major at California Baptist University.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}