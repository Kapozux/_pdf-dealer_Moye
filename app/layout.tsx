import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "墨页 · PDF/PPT/Word/图片 转 Markdown",
  description: "在本地将 PDF、PPT、Word、图片转换为干净、可检查的 Markdown。",
};

/**
 * 页面一加载就按记住的外观设好 <html data-theme>（在 React 之前跑，避免先闪一下错的颜色）。
 * 没选过 = 跟随系统（globals.css 里的 prefers-color-scheme）。切换按钮在顶栏（page.tsx 的 cycleTheme）。
 */
const themeScript = "try{var t=localStorage.getItem('moye_theme');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t}catch(e){}";

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body>{children}</body>
    </html>
  );
}
