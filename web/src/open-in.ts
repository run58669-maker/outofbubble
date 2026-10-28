/** Card types the "Open in" row knows about; mirrors the app's TargetType. */
export type OpenInType = "artist" | "book" | "podcast" | "movie" | "tv_show" | "video_game" | "place";
export type OpenInLink = { label: string; url: string };

/**
 * Typed "Open in" search links for a card: plain public search URLs, no API keys.
 * The generic web search always comes last. `city` is only used for places.
 */
export function openInLinks(type: OpenInType, title: string, city?: string): OpenInLink[] {
  const q = encodeURIComponent(title);
  const screen = [
    { label: "Letterboxd", url: `https://letterboxd.com/search/${q}/` },
    { label: "JustWatch", url: `https://www.justwatch.com/us/search?q=${q}` },
  ];
  const typed: Record<OpenInType, OpenInLink[]> = {
    artist: [
      { label: "Spotify", url: `https://open.spotify.com/search/${q}` },
      { label: "Bandcamp", url: `https://bandcamp.com/search?q=${q}` },
    ],
    book: [
      { label: "Goodreads", url: `https://www.goodreads.com/search?q=${q}` },
      { label: "Bookshop.org", url: `https://bookshop.org/search?keywords=${q}` },
    ],
    podcast: [
      { label: "Apple Podcasts", url: `https://podcasts.apple.com/search?term=${q}` },
      { label: "Spotify", url: `https://open.spotify.com/search/${q}` },
    ],
    movie: screen,
    tv_show: screen,
    video_game: [
      { label: "Steam", url: `https://store.steampowered.com/search/?term=${q}` },
      { label: "IGDB", url: `https://www.igdb.com/search?q=${q}` },
    ],
    place: [
      { label: "Google Maps", url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([title, city?.trim()].filter(Boolean).join(" "))}` },
    ],
  };
  const web = { label: "Web", url: `https://duckduckgo.com/?q=${encodeURIComponent(`${title} ${type.replace("_", " ")}`)}` };
  return [...(typed[type] ?? []), web];
}
