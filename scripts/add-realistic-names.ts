#!/usr/bin/env tsx
/**
 * Add realistic names to fixture files.
 * Replaces Person{N} placeholders with realistic first/last name combinations.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";

// Realistic name pool
const FIRST_NAMES = [
  "Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Avery", "Quinn",
  "Sage", "Dakota", "River", "Phoenix", "Skylar", "Rowan", "Blake", "Cameron",
  "Drew", "Emery", "Finley", "Hayden", "Jamie", "Kai", "Logan", "Micah",
  "Noah", "Parker", "Reese", "Sam", "Tyler", "Zoe",
  // More traditional names
  "Sarah", "Michael", "Emily", "David", "Jessica", "James", "Jennifer", "John",
  "Lisa", "Robert", "Michelle", "William", "Ashley", "Richard", "Amanda", "Joseph",
  "Melissa", "Thomas", "Deborah", "Charles", "Stephanie", "Christopher", "Rebecca",
  "Daniel", "Sharon", "Matthew", "Laura", "Anthony", "Donna", "Mark", "Nancy",
  "Donald", "Karen", "Steven", "Betty", "Andrew", "Helen", "Paul", "Sandra",
  "Joshua", "Donna", "Kenneth", "Carol", "Kevin", "Ruth", "Brian", "Sharon",
  "George", "Michelle", "Timothy", "Laura", "Ronald", "Sarah", "Jason", "Kimberly",
  "Edward", "Deborah", "Jeffrey", "Jessica", "Ryan", "Shirley", "Jacob", "Cynthia",
  "Gary", "Angela", "Nicholas", "Brenda", "Eric", "Emma", "Jonathan", "Olivia",
  "Stephen", "Catherine", "Larry", "Christine", "Justin", "Samantha", "Scott", "Deborah",
  "Brandon", "Rachel", "Benjamin", "Carolyn", "Samuel", "Janet", "Gregory", "Virginia",
  "Alexander", "Maria", "Patrick", "Heather", "Frank", "Diane", "Raymond", "Julie",
  "Jack", "Joyce", "Dennis", "Victoria", "Jerry", "Kelly", "Tyler", "Christina",
  "Aaron", "Joan", "Jose", "Evelyn", "Henry", "Judith", "Adam", "Megan",
  "Douglas", "Cheryl", "Nathan", "Andrea", "Zachary", "Hannah", "Kyle", "Jacqueline",
  "Noah", "Martha", "Ethan", "Gloria", "Jeremy", "Teresa", "Walter", "Sara",
  "Christian", "Janice", "Keith", "Marie", "Roger", "Julia", "Terry", "Grace",
  "Sean", "Judy", "Gerald", "Theresa", "Dylan", "Madison", "Carl", "Beverly",
  "Harold", "Denise", "Austin", "Marilyn", "Wayne", "Amber", "Peter", "Danielle",
  "Alan", "Brittany", "Juan", "Diana", "Lawrence", "Abigail", "Roy", "Jane",
  "Ralph", "Lori", "Randy", "Mildred", "Eugene", "Kathryn", "Vincent", "Rose",
  "Russell", "Brenda", "Louis", "Emma", "Philip", "Catherine", "Bobby", "Debra",
  "Johnny", "Rachel", "Willie", "Carolyn", "Arthur", "Janet", "Albert", "Virginia",
];

const LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
  "Rodriguez", "Martinez", "Hernandez", "Lopez", "Wilson", "Anderson", "Thomas", "Taylor",
  "Moore", "Jackson", "Martin", "Lee", "Thompson", "White", "Harris", "Sanchez",
  "Clark", "Ramirez", "Lewis", "Robinson", "Walker", "Young", "Allen", "King",
  "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores", "Green", "Adams",
  "Nelson", "Baker", "Hall", "Rivera", "Campbell", "Mitchell", "Carter", "Roberts",
  "Gomez", "Phillips", "Evans", "Turner", "Diaz", "Parker", "Cruz", "Edwards",
  "Collins", "Reyes", "Stewart", "Morris", "Morales", "Murphy", "Cook", "Rogers",
  "Gutierrez", "Ortiz", "Morgan", "Cooper", "Peterson", "Bailey", "Reed", "Kelly",
  "Howard", "Ramos", "Kim", "Cox", "Ward", "Richardson", "Watson", "Brooks",
  "Chavez", "Wood", "James", "Bennett", "Gray", "Mendoza", "Ruiz", "Hughes",
  "Price", "Alvarez", "Castillo", "Sanders", "Patel", "Myers", "Long", "Ross",
  "Foster", "Jimenez", "Powell", "Jenkins", "Perry", "Russell", "Sullivan", "Bell",
  "Coleman", "Butler", "Henderson", "Barnes", "Gonzales", "Fisher", "Vasquez", "Simmons",
  "Romero", "Jordan", "Patterson", "Alexander", "Hamilton", "Graham", "Reynolds", "Griffin",
  "Wallace", "Moreno", "West", "Cole", "Hayes", "Bryant", "Herrera", "Gibson",
  "Ellis", "Tran", "Medina", "Aguilar", "Stevens", "Murray", "Ford", "Castro",
  "Marshall", "Owens", "Harrison", "Fernandez", "Mcdonald", "Woods", "Washington", "Kennedy",
  "Wells", "Vargas", "Henry", "Chen", "Freeman", "Webb", "Tucker", "Guzman",
  "Burns", "Crawford", "Olson", "Simpson", "Porter", "Hunter", "Gordon", "Mendez",
  "Silva", "Shaw", "Snyder", "Mason", "Dixon", "Munoz", "Hunt", "Hicks",
  "Holmes", "Palmer", "Wagner", "Black", "Robertson", "Boyd", "Rose", "Stone",
  "Salazar", "Fox", "Warren", "Johnston", "Weaver", "Lane", "Andrews", "Ruiz",
  "Harper", "Fox", "Riley", "Armstrong", "Carpenter", "Weaver", "Greene", "Lawrence",
  "Elliott", "Chavez", "Sims", "Austin", "Peters", "Kelley", "Franklin", "Lawson",
  "Fields", "Gutierrez", "Ryan", "Schmidt", "Carr", "Vasquez", "Castillo", "Wheeler",
  "Chapman", "Oliver", "Montgomery", "Richards", "Williamson", "Johnston", "Banks", "Meyer",
  "Bishop", "Mccoy", "Howell", "Alvarez", "Morrison", "Hansen", "Fernandez", "Garza",
  "Harvey", "Little", "Burton", "Stanley", "Nguyen", "George", "Jacobs", "Reid",
  "Kim", "Fuller", "Lynch", "Dean", "Gilbert", "Garrett", "Romero", "Welch",
  "Larson", "Frazier", "Burke", "Hanson", "Day", "Mendoza", "Moreno", "Bowman",
  "Medina", "Fowler", "Brewer", "Hoffman", "Carlson", "Silva", "Pearson", "Holland",
  "Douglas", "Fleming", "Jensen", "Vargas", "Byrd", "Davidson", "Hopkins", "May",
  "Terry", "Herrera", "Wade", "Soto", "Walters", "Curtis", "Neal", "Caldwell",
  "Lowe", "Jennings", "Barnett", "Graves", "Jimenez", "Horton", "Shelton", "Barrett",
  "Obrien", "Castro", "Sutton", "Gregory", "Mckinney", "Lucas", "Miles", "Craig",
  "Rodriquez", "Chambers", "Holt", "Lambert", "Fletcher", "Watts", "Bates", "Hale",
  "Rhodes", "Pena", "Beck", "Newman", "Haynes", "Mcdaniel", "Mendez", "Bush",
  "Vaughn", "Parks", "Dawson", "Santiago", "Norris", "Hardy", "Love", "Steele",
  "Curry", "Powers", "Schultz", "Barker", "Guzman", "Page", "Munoz", "Ball",
  "Keller", "Chandler", "Weber", "Leonard", "Walsh", "Lyons", "Ramsey", "Wolfe",
  "Schneider", "Mullins", "Benson", "Sharp", "Bowen", "Daniel", "Barber", "Cummings",
  "Hines", "Baldwin", "Griffith", "Valdez", "Hubbard", "Salinas", "Reeves", "Warner",
  "Marsh", "Bush", "Vaughn", "Parks", "Dawson", "Santiago", "Norris", "Hardy",
  "Love", "Steele", "Curry", "Powers", "Schultz", "Barker", "Guzman", "Page",
];

// Create a deterministic mapping from Person{N} to realistic names
const nameMap = new Map<string, string>();

function getRealisticName(personId: string): string {
  if (nameMap.has(personId)) {
    return nameMap.get(personId)!;
  }
  
  // Extract number from Person{N}
  const match = personId.match(/Person(\d+)/);
  const num = match ? parseInt(match[1], 10) : Math.random() * 10000;
  
  // Use number to deterministically select names
  const firstName = FIRST_NAMES[num % FIRST_NAMES.length];
  const lastName = LAST_NAMES[Math.floor(num / FIRST_NAMES.length) % LAST_NAMES.length];
  
  const fullName = `${firstName} ${lastName}`;
  nameMap.set(personId, fullName);
  return fullName;
}

function processFixture(fixture: any): any {
  // Replace fromName if it's a Person{N} placeholder
  if (fixture.fromName && typeof fixture.fromName === "string" && fixture.fromName.startsWith("Person")) {
    fixture.fromName = getRealisticName(fixture.fromName);
  }
  
  // Replace Person{N} in bodyText and subject
  if (fixture.bodyText) {
    fixture.bodyText = fixture.bodyText.replace(/Person\d+/g, (match) => {
      return getRealisticName(match);
    });
  }
  
  if (fixture.subject) {
    fixture.subject = fixture.subject.replace(/Person\d+/g, (match) => {
      return getRealisticName(match);
    });
  }
  
  return fixture;
}

function main() {
  const yamlPath = join(process.cwd(), "tests/ask/realistic-inbox.yaml");
  const yaml = readFileSync(yamlPath, "utf-8");
  const data = parse(yaml) as { messages: any[] };
  
  console.log(`Processing ${data.messages.length} messages...`);
  
  // Process each message
  data.messages = data.messages.map(processFixture);
  
  // Write back
  writeFileSync(yamlPath, stringify(data, { lineWidth: 120, indent: 2 }));
  
  console.log(`Updated ${data.messages.length} messages with realistic names`);
  console.log(`Sample names used: ${Array.from(nameMap.values()).slice(0, 10).join(", ")}`);
}

main();
