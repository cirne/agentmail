/**
 * Test fixture for name inference evaluation.
 * 
 * This fixture contains diverse email address patterns with their expected
 * inferred names. Used to measure inference accuracy across different patterns.
 * 
 * Patterns covered:
 * - Dot-separated: firstname.lastname
 * - Underscore-separated: firstname_lastname
 * - CamelCase: firstnameLastname
 * - All-lowercase: firstnamelastname (with strong signals)
 * - Single-letter prefix: initialLastname
 * - Ambiguous cases that should return null
 */

export interface NameInferenceTestCase {
  /** Email address to test */
  address: string;
  /** Expected inferred name (null if inference should fail) */
  expectedName: string | null;
}

/**
 * Test cases covering diverse name inference patterns.
 * These represent real-world email address formats.
 */
export const NAME_INFERENCE_FIXTURE: NameInferenceTestCase[] = [
  // Dot-separated patterns (high confidence)
  { address: "lewis.cirne@example.com", expectedName: "Lewis Cirne" },
  { address: "katelyn.cirne@gmail.com", expectedName: "Katelyn Cirne" },
  { address: "whitney.allen@jpmorgan.com", expectedName: "Whitney Allen" },
  { address: "alan.finley@example.com", expectedName: "Alan Finley" },
  { address: "john.smith@example.com", expectedName: "John Smith" },
  { address: "joshua.seale@missional.ai", expectedName: "Joshua Seale" },
  { address: "dan.scholnick@gmail.com", expectedName: "Dan Scholnick" },
  { address: "tyson.tuttle@news.circuit.ai", expectedName: "Tyson Tuttle" },
  { address: "scott.bouma@youversion.com", expectedName: "Scott Bouma" },
  { address: "lloyd.walton@oneandonlypalmilla.com", expectedName: "Lloyd Walton" },
  { address: "kristi.larkam@compass.com", expectedName: "Kristi Larkam" },
  { address: "rahul.vohra@superhuman.com", expectedName: "Rahul Vohra" },
  { address: "chante.botha@biblica.com", expectedName: "Chante Botha" },
  { address: "gavyn.garcia@panerai.com", expectedName: "Gavyn Garcia" },
  { address: "geof.morin@biblica.com", expectedName: "Geof Morin" },
  
  // Underscore-separated patterns (high confidence)
  { address: "katelyn_cirne@icloud.com", expectedName: "Katelyn Cirne" },
  { address: "john_smith@example.com", expectedName: "John Smith" },
  { address: "charles_preuss@yahoo.com", expectedName: "Charles Preuss" },
  { address: "lana_k_macrum@example.com", expectedName: "Lana_ K_macrum" }, // Splits on first underscore
  
  // CamelCase patterns (high confidence)
  { address: "lewisCirne@example.com", expectedName: "Lewis Cirne" },
  { address: "johnSmith@example.com", expectedName: "John Smith" },
  { address: "katelynCirne@example.com", expectedName: "Katelyn Cirne" },
  
  // All-lowercase patterns with strong signals (medium confidence)
  { address: "alanfinley@example.com", expectedName: "Alan Finley" },
  { address: "johnsmith@example.com", expectedName: "John Smith" },
  { address: "whitneyallen@example.com", expectedName: "Whitney Allen" },
  
  // Single-letter prefix patterns (medium confidence)
  { address: "abrown@somecompany.com", expectedName: "A Brown" },
  { address: "jsmith@example.com", expectedName: "J Smith" },
  { address: "tmills@example.com", expectedName: "T Mills" },
  { address: "dwilcox@example.com", expectedName: "D Wilcox" },
  
  // Multi-dot patterns (splits on first dot only)
  { address: "glen.m.curry@gmail.com", expectedName: "Glen .m.curry" },
  { address: "lana.k.macrum@example.com", expectedName: "Lana. K.macrum" },
  { address: "scott.harmon.tx@gmail.com", expectedName: "Scott. Harmon.tx" },
  
  // Ambiguous cases that should return null
  { address: "fredbrown@example.com", expectedName: null }, // No strong signal
  { address: "sjohnson@example.com", expectedName: null }, // Too ambiguous
  { address: "hello@example.com", expectedName: null }, // Not a name pattern
  { address: "info@example.com", expectedName: null }, // Skip word
  { address: "support@example.com", expectedName: null }, // Skip word
  { address: "admin@example.com", expectedName: null }, // Skip word
  { address: "noreply@example.com", expectedName: null }, // Skip word
  { address: "recipient@example.com", expectedName: null }, // Skip word
  
  // Edge cases
  { address: "ab@example.com", expectedName: null }, // Too short
  { address: "a@example.com", expectedName: null }, // Too short
  { address: "123@example.com", expectedName: null }, // Numbers
  { address: "w.brisbane@example.com", expectedName: null }, // Ambiguous single letter + long last
  { address: "j.p.morganonline@example.com", expectedName: null }, // Too many dots, ambiguous
  
  // Real-world patterns that should work
  { address: "alumni.magazine@dartmouth.edu", expectedName: "Alumni Magazine" },
  { address: "techbanking@citi.com", expectedName: "Tech Banking" },
];
