import './globals.css'

export const metadata = {
  metadataBase: new URL('https://klyppr.mkdir.dev'),
  title: 'Klyppr - Smart Video Silence Trimmer',
  description: 'Automatically detect and remove silent parts from your videos. Fast, easy, and browser-based video silence trimming tool.',
  keywords: 'video editing, silence removal, video trimming, online video editor, silence detection',
  authors: [{ name: 'Muzaffer Kadir YILMAZ', url: 'https://mkdir.dev' }],
  creator: 'Muzaffer Kadir YILMAZ',
  publisher: 'Muzaffer Kadir YILMAZ',
  openGraph: {
    title: 'Klyppr - Smart Video Silence Trimmer',
    description: 'Automatically detect and remove silent parts from your videos',
    url: 'https://klyppr.mkdir.dev',
    siteName: 'Klyppr',
    images: [
      {
        url: '/logo.png',
        width: 800,
        height: 800,
      },
    ],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Klyppr - Smart Video Silence Trimmer',
    description: 'Automatically detect and remove silent parts from your videos',
    images: ['/logo.png'],
    creator: '@muzafferkadir',
  },
  icons: {
    icon: '/logo.png',
    shortcut: '/logo.png',
    apple: '/logo.png',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/logo.png" />
      </head>
      <body>{children}</body>
    </html>
  )
}
