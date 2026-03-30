/**
 * Nickname dictionary for name normalization.
 * Maps common nicknames/diminutives to their canonical first names.
 */

const NICKNAMES: Record<string, string> = {
  // Lewis variants
  lew: "lewis",
  louie: "lewis",
  lou: "lewis",
  // Robert variants
  bob: "robert",
  rob: "robert",
  bobby: "robert",
  robbie: "robert",
  bert: "robert",
  // William variants
  bill: "william",
  will: "william",
  billy: "william",
  wil: "william",
  liam: "william",
  // Katherine variants
  kate: "katherine",
  kathy: "katherine",
  kat: "katherine",
  katie: "katherine",
  kath: "katherine",
  // Christopher variants
  chris: "christopher",
  // Michael variants
  mike: "michael",
  mikey: "michael",
  mick: "michael",
  // James variants
  jim: "james",
  jimmy: "james",
  // John variants
  jack: "john",
  johnny: "john",
  // Elizabeth variants
  liz: "elizabeth",
  lizzie: "elizabeth",
  betty: "elizabeth",
  beth: "elizabeth",
  // Richard variants
  dick: "richard",
  rick: "richard",
  rich: "richard",
  ricky: "richard",
  // Joseph variants
  joe: "joseph",
  joey: "joseph",
  // Thomas variants
  tom: "thomas",
  tommy: "thomas",
  // Daniel variants
  dan: "daniel",
  danny: "daniel",
  // Matthew variants
  matt: "matthew",
  matty: "matthew",
  // Andrew variants
  andy: "andrew",
  drew: "andrew",
  // Edward variants
  ed: "edward",
  eddie: "edward",
  eddy: "edward",
  // Charles variants
  charlie: "charles",
  chuck: "charles",
  // David variants
  dave: "david",
  davey: "david",
  // Steven/Stephen variants
  steve: "steven",
  stephen: "steven",
  // Jennifer variants
  jen: "jennifer",
  jenny: "jennifer",
  jenn: "jennifer",
  // Patricia variants
  pat: "patricia",
  patty: "patricia",
  tricia: "patricia",
  // Margaret variants
  maggie: "margaret",
  meg: "margaret",
  peg: "margaret",
  // Susan variants
  sue: "susan",
  susie: "susan",
  // Jessica variants
  jess: "jessica",
  jessie: "jessica",
  // Sarah variants
  sara: "sarah",
  // Emily variants
  em: "emily",
  emmie: "emily",
  // Amanda variants
  mandy: "amanda",
  // Melissa variants
  mel: "melissa",
  missy: "melissa",
  // Nicole variants
  nikki: "nicole",
  nic: "nicole",
  // Stephanie variants
  steph: "stephanie",
  steff: "stephanie",
  // Michelle variants
  shell: "michelle",
  // Kimberly variants
  kim: "kimberly",
  kimmy: "kimberly",
  // Anthony variants
  tony: "anthony",
  // Benjamin variants
  ben: "benjamin",
  benny: "benjamin",
  // Joshua variants
  josh: "joshua",
  // Samuel variants
  sam: "samuel",
  sammy: "samuel",
  // Jonathan variants
  jon: "jonathan",
  jonny: "jonathan",
  // Nathan variants
  nate: "nathan",
  // Ryan variants
  ryan: "ryan",
  // Brandon variants
  brandon: "brandon",
  // Justin variants
  justin: "justin",
  // Kevin variants
  kev: "kevin",
  // Brian variants
  bryan: "brian",
  // Jason variants
  jay: "jason",
  // Gregory variants
  greg: "gregory",
  // Raymond variants
  ray: "raymond",
  // Alexander variants
  alex: "alexander",
  // Patrick variants
  patrick: "patrick",
  // Dennis variants
  denny: "dennis",
  // Jerry variants
  jeremiah: "jerry",
  // Tyler variants
  ty: "tyler",
  // Aaron variants
  ron: "aaron",
  // Henry variants
  hank: "henry",
  // Douglas variants
  doug: "douglas",
  // Zachary variants
  zach: "zachary",
  // Kyle variants
  kyle: "kyle",
  // Noah variants
  noah: "noah",
  // Dylan variants
  dylan: "dylan",
  // Logan variants
  logan: "logan",
  // Christian variants
  christian: "christian",
  // Hunter variants
  hunter: "hunter",
  // Austin variants
  austin: "austin",
  // Evan variants
  evan: "evan",
  // Luke variants
  luke: "luke",
  // Angel variants
  angel: "angel",
  // Isaiah variants
  isaiah: "isaiah",
  // Isaac variants
  isaac: "isaac",
  // Mason variants
  mason: "mason",
  // Lawrence variants
  larry: "lawrence",
  // Frank variants
  frankie: "frank",
  // Scott variants
  scotty: "scott",
  // Randy variants
  randy: "randall",
  // Donald variants
  don: "donald",
  donny: "donald",
  // Kenneth variants
  ken: "kenneth",
  kenny: "kenneth",
  // Paul variants
  paulie: "paul",
  // George variants
  georgie: "george",
  // Gary variants
  gary: "gary",
  // Nicholas variants
  nick: "nicholas",
  nicky: "nicholas",
  // Eric variants
  erik: "eric",
  // Jacob variants
  jake: "jacob",
  // Timothy variants
  tim: "timothy",
  timmy: "timothy",
  // Jeffrey variants
  jeff: "jeffrey",
};

/**
 * Get the canonical first name for a given first name.
 * Returns the canonical form if found in the nickname dictionary, otherwise returns the input lowercased.
 */
export function canonicalFirstName(name: string): string {
  const lower = name.toLowerCase().trim();
  return NICKNAMES[lower] || lower;
}

const SUFFIXES = ["jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "phd", "md", "esq"];

/**
 * Parse a display name into first and last name components.
 * Handles middle names, suffixes, and single-name cases.
 */
export function parseName(displayName: string | null): { first: string | null; last: string | null } {
  if (!displayName) return { first: null, last: null };

  const trimmed = displayName.trim();
  if (!trimmed) return { first: null, last: null };

  const parts = trimmed.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0].toLowerCase(), last: null };

  // Last token is the last name (strip suffixes)
  let lastIndex = parts.length - 1;
  const lastToken = parts[lastIndex].toLowerCase().replace(/\.$/, ""); // Remove trailing period
  if (SUFFIXES.includes(lastToken)) {
    lastIndex--;
  }

  if (lastIndex < 0) {
    // All tokens were suffixes
    return { first: parts[0].toLowerCase(), last: null };
  }

  const last = parts[lastIndex].toLowerCase();
  const first = parts[0].toLowerCase();

  return { first, last };
}

/**
 * Determine if a name can be parsed into firstname/lastname (person name)
 * vs should be kept as a single name field (company/group/other).
 * 
 * Returns parsed components if it's a person name, null otherwise.
 */
export function parsePersonName(
  displayName: string | null
): { firstname: string; lastname: string } | null {
  if (!displayName) return null;

  const trimmed = displayName.trim();
  if (!trimmed) return null;

  // Check for company/group indicators (comma, "Inc", "LLC", etc.)
  const companyIndicators = [
    /,?\s*(inc|llc|ltd|corp|corporation|company|co\.|group|team|department|dept)/i,
    /^[A-Z][a-z]+\s+[A-Z][a-z]+,\s+Inc/i, // "Apple, Inc"
  ];
  if (companyIndicators.some((pattern) => pattern.test(trimmed))) {
    return null; // Company/group name, not a person
  }

  const parsed = parseName(trimmed);
  
  // Only return if we have both first and last name
  if (parsed.first && parsed.last) {
    // Capitalize properly
    const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    return {
      firstname: capitalize(parsed.first),
      lastname: capitalize(parsed.last),
    };
  }

  return null; // Can't parse into firstname/lastname
}
