import { Hero } from '@/components/hero';
import { AboutSnippet } from '@/components/about-snippet';
import { FeaturedWork } from '@/components/featured-work';

export default function Home() {
  return (
    <>
      <Hero />
      <AboutSnippet />
      <FeaturedWork />
    </>
  );
}
