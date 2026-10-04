import { Hero } from '@/components/hero';
import { AboutSnippet } from '@/components/about-snippet';
import { FeaturedWork } from '@/components/featured-work';
import { PlayTeaser } from '@/components/play-teaser';
import { BuildingTeaser } from '@/components/building-teaser';

export default function Home() {
  return (
    <>
      <Hero />
      <AboutSnippet />
      <FeaturedWork />
      <PlayTeaser />
      <BuildingTeaser />
    </>
  );
}
