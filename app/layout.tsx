import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "墨页 · PDF 转 Markdown",
  description: "在本地将 PDF 转换为干净、可检查的 Markdown。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-Hant"><body>{children}</body></html>;
}
