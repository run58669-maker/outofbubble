import { describe, expect, it } from "vitest";
import { openInLinks, type OpenInType } from "./open-in.js";

const TYPES: OpenInType[] = ["artist", "book", "podcast", "movie", "tv_show", "video_game", "place"];

describe("typed Open-in links", () => {
  it("gives each card type its own services, with web search last", () => {
    const labels = (type: OpenInType) => openInLinks(type, "X").map((link) => link.label);
    expect(labels("artist")).toEqual(["Spotify", "Bandcamp", "Web"]);
    expect(labels("book")).toEqual(["Goodreads", "Bookshop.org", "Web"]);
    expect(labels("podcast")).toEqual(["Apple Podcasts", "Spotify", "Web"]);
    expect(labels("movie")).toEqual(["Letterboxd", "JustWatch", "Web"]);
    expect(labels("tv_show")).toEqual(["Letterboxd", "JustWatch", "Web"]);
    expect(labels("video_game")).toEqual(["Steam", "IGDB", "Web"]);
    expect(labels("place")).toEqual(["Google Maps", "Web"]);
  });

  it("encodes the title into plain https search URLs", () => {
    const links = openInLinks("book", "The Left Hand of Darkness & Co");
    expect(links[0].url).toBe("https://www.goodreads.com/search?q=The%20Left%20Hand%20of%20Darkness%20%26%20Co");
    expect(links[1].url).toBe("https://bookshop.org/search?keywords=The%20Left%20Hand%20of%20Darkness%20%26%20Co");
    expect(links.at(-1)?.url).toBe("https://duckduckgo.com/?q=The%20Left%20Hand%20of%20Darkness%20%26%20Co%20book");
    for (const type of TYPES) {
      for (const link of openInLinks(type, "a/b?c")) {
        expect(link.url.startsWith("https://")).toBe(true);
        expect(link.url).not.toContain("a/b?c");
      }
    }
  });

  it("adds the city to the Google Maps query for places", () => {
    expect(openInLinks("place", "Kissa Zou", " Kyoto ")[0].url).toBe("https://www.google.com/maps/search/?api=1&query=Kissa%20Zou%20Kyoto");
    expect(openInLinks("place", "Kissa Zou")[0].url).toBe("https://www.google.com/maps/search/?api=1&query=Kissa%20Zou");
  });
});
