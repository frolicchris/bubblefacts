process.env.SSL_ACCESS_TOKEN = "test-token";
process.env.SSL_STREAMER_NAME = "tester";

import { actsFirst, goodSentences } from "./artist-good";
import { neutralBreach, loadedCaption, NEUTRAL_PROMPT } from "./neutral-wording";
import { namesIdentity, standardBreach } from "./content-standard";
import { artistGoodFromEntity, clearArticleItemCache, Entity, sureArtist } from "./wikidata";
import { interest } from "./fact-ranking";

const page = (section: string, body: string) => `Mara Quillon is a singer.\n\n== ${section} ==\n${body}\n`;
const good = (section: string, body: string) => goodSentences(page(section, body), "Mara Quillon");

describe("goodSentences", () => {
  it.each([
    ["Philanthropy", "In 1998, Quillon founded the Lantern Foundation in her hometown.", "In 1998, Mara Quillon founded the Lantern Foundation in her hometown."],
    ["Charity work", "She donated $2 million to earthquake relief.", "Mara Quillon donated $2 million to earthquake relief."],
    ["Career", "Quillon headlined the Harbor Aid benefit concert.", "Mara Quillon headlined the Harbor Aid benefit concert."],
    ["Teaching", "She gave masterclasses at the Northfield Conservatory.", "Mara Quillon gave masterclasses at the Northfield Conservatory."],
    ["Community", "Quillon hosted a youth festival in Ashford.", "Mara Quillon hosted a youth festival in Ashford."],
    ["Advocacy", "She became a patron of the Harbor Trust in 1999.", "Mara Quillon became a patron of the Harbor Trust in 1999."],
    ["Career", "Quillon revived traditional songs of the Ashford valley.", "Mara Quillon revived traditional songs of the Ashford valley."],
    ["Career", "Quillon released her stems for free download.", "Mara Quillon released her stems for free download."],
    ["Career", "Quillon performed at a benefit for flood relief.", "Mara Quillon performed at a benefit for flood relief."],
    ["Honors", "A statue of her stands in Ashford, named in honor of her.", "A statue of Mara Quillon stands in Ashford, named in honor of her."],
    ["Honors", "Asteroid 90210 Quillon was named after Mara Quillon.", "Asteroid 90210 Quillon was named after Mara Quillon."],
    ["Honors", "She was inducted into the Ashford Hall of Fame in 2001.", "Mara Quillon was inducted into the Ashford Hall of Fame in 2001."],
  ])("takes the act: %s, %s", (section, body, want) => {
    expect(good(section, body)).toEqual([want]);
  });

  it("keeps the act and drops a closing clause that won't fit a bubble", () => {
    const long = "In 1988, Quillon founded the non-profit Lantern Foundation, originally to improve the reading of every schoolchild in the counties around her home town and beyond them.";
    expect(good("Philanthropy", long)).toEqual(["In 1988, Mara Quillon founded the non-profit Lantern Foundation."]);
  });

  it.each([
    ["another subject", "Philanthropy", "Her manager founded the Lantern Foundation."],
    ["a pronoun that may be someone else", "Philanthropy", "Quillon met Dan Example. His sister knew him well. He founded the Lantern Foundation."],
    ["a verb with no cause", "Philanthropy", "Quillon supported the band on tour."],
    ["raised, as in grew up", "Philanthropy", "She was raised in Ashford."],
    ["a chance word beside a music verb", "Career", "Quillon recorded five tracks at Ashford College."],
    ["a name, not a deed", "Career", "Mara Quillon Archives holds her letters and the Lantern Foundation papers."],
    ["a commercial role", "Career", "In 2002, Quillon became the official spokesman of the Lantern Foundation."],
    ["a movement told in a sentence", "Career", "Quillon was part of the Lowfield movement."],
    ["a characterization", "Philanthropy", "Quillon has been involved in philanthropy across her career."],
    ["a concert outside a section about such things", "Career", "Quillon performed at the Ashford Festival."],
    ["a plan", "Philanthropy", "She announced a benefit concert to raise funds."],
    ["a nomination", "Honors", "Quillon received an Emmy Award nomination."],
    ["a dangling reference", "Philanthropy", "Quillon was named chair of the board of the project."],
    ["a politics section", "Political activism", "Quillon donated $5,000 to the Lantern Foundation."],
  ])("leaves out %s", (_why, section, body) => {
    expect(good(section, body)).toEqual([]);
  });

  it.each(["supported same-sex marriage", "opposed the Iraq War", "backed a ban on fracking", "is a lifetime member of the National Rifle Association", "lobbied for repeal of Don't Ask, Don't Tell", "supports the Occupy movement", "criticized the Ashford dam", "called for clean water", "campaigned for clean water"])(
    "a stance has no act shape: %s",
    (stance) => {
      expect(good("Philanthropy", `Quillon ${stance} and the Lantern Foundation.`)).toEqual([]);
    }
  );

  it("puts acts first and caps honors", () => {
    const list = ["Mara Quillon received the Ashford Medal.", "Mara Quillon was inducted into the Ashford Hall of Fame.", "Mara Quillon founded a charity."].map((text) => ({ text }));
    expect(actsFirst(list, 1).map((f) => f.text)).toEqual(["Mara Quillon founded a charity.", "Mara Quillon received the Ashford Medal."]);
  });
});

describe("the neutral wording line", () => {
  it.each([
    "Mara Quillon headlined a concert against hunger.",
    "Rage Against the Machine headlined a benefit for flood relief.",
    "Mara Quillon performed at a Rock Against Racism benefit.",
    "Mara Quillon became a patron of the Harbor Trust in 1999.",
    "Mara Quillon performed at a benefit for war refugees.",
    "Mara Quillon was named a UNICEF Goodwill Ambassador.",
    "Mara Quillon received the Presidential Medal of Freedom.",
    "Mara Quillon co-founded the Lantern Fund for displaced families.",
    "Mara Quillon wrote to lawmakers on musicians' rights in an open letter.",
    "Mara Quillon donated to a War Child benefit.",
  ])("lets through: %s", (fact) => {
    expect(neutralBreach(fact)).toBeNull();
  });

  it.each([
    ["Mara Quillon endorsed a candidate for mayor.", "elections or parties"],
    ["Mara Quillon performed at a Republican Party dinner.", "elections or parties"],
    ["Mara Quillon performed at a Green Party fundraiser.", "elections or parties"],
    ["Mara Quillon has backed the Lowfield independence movement.", "a contested fight"],
    ["Mara Quillon performed at a benefit for gun control.", "a contested fight"],
    ["Mara Quillon performed at a concert against the war.", "a contested fight"],
    ["Mara Quillon performed at a rally against the Ashford government.", "a contested fight"],
    ["X supported same-sex marriage.", "a contested fight"],
    ["X opposed the Iraq War.", "a contested fight"],
    ["X backed a ban on fracking.", "a contested fight"],
    ["X is a lifetime member of the National Rifle Association.", "a contested fight"],
    ["X lobbied for repeal of Don't Ask, Don't Tell.", "a contested fight"],
    ["X supports the Occupy movement.", "a contested fight"],
    ["Mara Quillon performed for marriage equality in Hong Kong.", "a contested fight"],
    ["Mara Quillon received an award for her activism.", "loaded wording"],
    ["Mara Quillon donated to a human rights group.", "loaded wording"],
    ["Mara Quillon reportedly raised funds for relief.", "a hedge"],
    ["Mara Quillon is a patron of the Harbor Trust.", "an undated role"],
    ["Mara Quillon donated $2 million to flood relief.", "a living person's money"],
    ["Mara Quillon signed an open letter on the Ashford treaty.", "an act that states a side"],
    ["Mara Quillon joined the boycott of Ashford.", "an act that states a side"],
    ["Mara Quillon is a champion of clean water.", "loaded wording"],
    ["Mara Quillon stood up to the Ashford council.", "loaded wording"],
    ["Mara Quillon is a tireless supporter of charity.", "loaded wording"],
    ["Mara Quillon gave to charity because of her father.", "a motive"],
    ["Mara Quillon was honored for her commitment to clean water.", "a motive"],
  ])("keeps out: %s", (fact, reason) => {
    expect(neutralBreach(fact)).toBe(reason);
  });

  it("allows a sum for someone no longer living", () => {
    expect(neutralBreach("Mara Quillon donated $2 million to flood relief.", [], false)).toBeNull();
  });

  it("reads the artist's name as a name", () => {
    expect(neutralBreach("Campaign Against Silence donated to charity.", ["Campaign Against Silence"])).toBeNull();
    expect(loadedCaption("Legendary Lanterns played a benefit.", ["Legendary Lanterns"])).toBe(false);
  });

  it("screens a caption for judging words only", () => {
    expect(loadedCaption("The controversial singer played in Ashford.")).toBe(true);
    expect(loadedCaption("The song's bass causes the floor to shake.")).toBe(false);
    expect(loadedCaption("The song came out in 1999.")).toBe(false);
  });

  it("asks the writer for the act, not a verdict", () => {
    expect(NEUTRAL_PROMPT).toMatch(/what they did and for whom/);
  });

  it("the content standard still comes first, and no list is loosened", () => {
    expect(standardBreach("Mara Quillon founded a cancer charity.")).not.toBeNull();
    expect(standardBreach("Mara Quillon performed in prison.")).not.toBeNull();
    expect(namesIdentity("Mara Quillon supported the Lowfield Christian Camping Movement.")).toBe(true);
  });
});

describe("artistGoodFromEntity", () => {
  const item = (id: string, label: string): Entity => ({ id, labels: { en: { value: label } } });
  const refs = (...ids: string[]) => ids.map((id) => ({ mainsnak: { datavalue: { value: { id } } } }));
  const labels = Object.fromEntries(
    [["Q1", "Fluxmode"], ["Q2", "UNICEF Goodwill Ambassador"], ["Q3", "Mayor of Ashford"], ["Q4", "Harbor Aid"], ["Q5", "Ashford Hall of Fame"], ["Q6", "Grammy Award for Best Song"], ["Q7", "Knight of the Order of Ashford"], ["Q8", "honorary doctorate"], ["Q9", "Dan Example"], ["Q10", "Musicians' Union"]].map(([id, l]) => [id, item(id, l)])
  );
  const artist: Entity = {
    ...item("Q0", "Mara Quillon"),
    claims: { P135: refs("Q1"), P39: refs("Q3", "Q2"), P1344: refs("Q4"), P463: refs("Q10"), P802: refs("Q9"), P166: refs("Q6", "Q5", "Q7", "Q8") },
  };

  it("builds each sentence from one statement and says no more", () => {
    expect(artistGoodFromEntity(artist, labels)).toEqual([
      "Mara Quillon was part of the Fluxmode movement.",
      "Mara Quillon has served as UNICEF Goodwill Ambassador.",
      "Mara Quillon took part in Harbor Aid.",
      "Mara Quillon is a member of the Musicians' Union.",
      "Mara Quillon's students include Dan Example.",
      "Mara Quillon received an honorary doctorate.",
      "Mara Quillon was inducted into the Ashford Hall of Fame.",
      "Mara Quillon was made a Knight of the Order of Ashford.",
    ]);
  });
});

describe("what the artist gave ranks with the rest", () => {
  it("beats a plain release line, and an award's penalty still counts", () => {
    expect(interest("Mara Quillon founded the Lantern Foundation.").score).toBe(2);
    expect(interest("Mara Quillon received the Presidential Medal of Freedom.").score).toBe(0 + 2);
    expect(interest('"Glass Orchard" came out in 1999.').score).toBe(0);
  });
});

describe("sureArtist", () => {
  const person = { id: "Q1", labels: { en: { value: "Mara Quillon" } }, descriptions: { en: { value: "Canadian singer" } }, claims: { P31: [{ mainsnak: { datavalue: { value: { id: "Q5" } } } }] }, sitelinks: { enwiki: { title: "Mara Quillon" } } };
  const song = { id: "Q2", labels: { en: { value: "Glass Orchard" } }, descriptions: { en: { value: "1999 song" } }, claims: { P31: [{ mainsnak: { datavalue: { value: { id: "Q7366" } } } }], P175: [{ mainsnak: { datavalue: { value: { id: "Q1" } } } }] } };
  const answer = (entities: object) => ({ ok: true, json: async () => ({ entities }) });
  const answers = (...list: object[]) => {
    const fetchMock = jest.fn();
    for (const a of list) fetchMock.mockResolvedValueOnce(answer(a));
    fetchMock.mockResolvedValue(answer({}));
    global.fetch = fetchMock as unknown as typeof fetch;
  };
  beforeEach(() => clearArticleItemCache());

  it("takes the performer the song's own item names, by item, not by a name search", async () => {
    answers({ Q2: song }, {}, { Q1: person });
    expect((await sureArtist("Glass Orchard", ["mara quillon"]))?.page).toBe("Mara Quillon");
  });

  it("takes the artist's own article when the item is that performer", async () => {
    answers({ Q1: person });
    expect((await sureArtist("Mara Quillon", ["mara quillon"]))?.page).toBe("Mara Quillon");
  });

  it("refuses a song whose performer is another act", async () => {
    answers({ Q2: song }, {}, { Q1: person });
    expect(await sureArtist("Glass Orchard", ["dan example"])).toBeNull();
  });

  it("refuses an article whose item is someone of another name", async () => {
    answers({ Q1: person });
    expect(await sureArtist("Mara Quillon", ["dan example"])).toBeNull();
  });
});
