import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TACAN Track Viewer',
  description: 'Private local-file WinFIS TACAN track review workspace.',
  icons: { icon: '/favicon.svg' },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
