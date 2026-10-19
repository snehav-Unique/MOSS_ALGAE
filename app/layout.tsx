import '@fontsource/playfair-display/400.css';
import '@fontsource/playfair-display/500.css';
import '@fontsource/playfair-display/600.css';
import '@fontsource/playfair-display/700.css';
import 'leaflet/dist/leaflet.css';
import './globals.css';

export const metadata = {
  title: 'MOSS—ALGAE INDIA | Future state of air',
  description: 'Place moss biofilters, compare the air now, and explore a modeled future.',
};

export default function Layout({children}:{children:React.ReactNode}) {
  return <html lang="en"><body>{children}</body></html>;
}
