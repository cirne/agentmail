# Eval Fixture Suite Organization

This directory contains YAML fixture files for the `zmail ask` evaluation suite. Fixtures are organized by scenario/use case to make them easy to maintain and extend.

## File Organization

**Recommendation: Multiple files organized by scenario**

- **One file per scenario/use case** — easier to find, modify, and test specific scenarios
- **Base file** (`eval-inbox.yaml`) — core fixtures for existing eval cases
- **Scenario files** — add new files as we expand coverage

### Current Structure

```
tests/ask/
├── eval-inbox.yaml          # Core fixtures (person lookup, recent emails, invoices)
├── transactional.yaml        # Receipts, invoices, confirmations, orders
├── conversations.yaml        # Multi-message threads, introductions, follow-ups
├── meetings.yaml             # Calendar invites, reminders, cancellations
├── attachments.yaml          # Messages with various attachment types
├── promotional.yaml          # Newsletters, marketing, noise (for testing filtering)
└── FIXTURES.md              # This file
```

## Email Categories to Cover

### 1. Transactional Emails
- **Receipts**: Apple, Amazon, Stripe, Square, etc.
- **Invoices**: Billing, services, subscriptions
- **Confirmations**: Orders, bookings, reservations
- **Shipping**: Tracking, delivery notifications
- **Payments**: Payment confirmations, refunds

**Realistic details:**
- Varied amounts ($9.99 to $999.99)
- Different date ranges (recent to old)
- Some with attachments (PDF receipts)
- Mix of noise vs. non-noise (some have List-Unsubscribe but are transactional)

### 2. Personal Conversations
- **Introductions**: First contact, networking
- **Follow-ups**: Multi-message threads
- **Questions/Answers**: Back-and-forth conversations
- **Social**: Personal messages, invitations

**Realistic details:**
- Thread relationships (same threadId)
- Natural conversation flow
- Varied participants (to/cc)
- Different time gaps between messages

### 3. Meetings & Calendar
- **Invites**: Google Calendar, Outlook, Calendly
- **Reminders**: Upcoming meetings
- **Updates**: Time changes, cancellations
- **RSVPs**: Accept/decline responses

**Realistic details:**
- .ics attachments
- Recurring vs. one-time
- Different organizers
- Various meeting types (1:1, team, all-hands)

### 4. Attachments
- **Documents**: PDFs, Word docs, spreadsheets
- **Data files**: CSV, Excel, JSON
- **Images**: Screenshots, diagrams
- **Archives**: ZIP files

**Realistic details:**
- Reference existing fixtures in `tests/attachments/fixtures/`
- Mix of small (inline content) and large (fixturePath)
- Various MIME types
- Some extracted text, some not

### 5. Promotional/Noise
- **Newsletters**: Tech, business, personal interests
- **Marketing**: Deals, promotions, announcements
- **Spam**: Low-quality, obvious spam
- **Social**: LinkedIn, Twitter, Facebook notifications

**Realistic details:**
- Proper noise markers (List-Unsubscribe + List-Id, Precedence: bulk)
- Gmail labels (Promotions, Social, Forums)
- Some edge cases (transactional-looking but promotional)
- Varied senders and domains

### 6. Edge Cases
- **Long subjects**: Very long subject lines
- **Empty bodies**: Subject-only emails
- **Special characters**: Unicode, emojis, HTML entities
- **Date ranges**: Very old (years), very recent (minutes)
- **Large threads**: 10+ message conversations
- **Mixed languages**: Non-English content

## Realism Guidelines

### Email Addresses
- Use realistic domains: `@apple.com`, `@amazon.com`, `@stripe.com`, `@gmail.com`
- Mix personal (`alice@example.com`) and corporate (`billing@company.com`)
- Include noreply addresses (`noreply@service.com`)

### Subject Lines
- Natural, varied formats:
  - "Your Apple Store receipt"
  - "Invoice #12345 from Acme Corp"
  - "Re: Meeting tomorrow at 3pm"
  - "Weekly Newsletter - March 2024"
- Avoid generic "Test email" patterns

### Body Text
- Natural language, not placeholder text
- Varied lengths (short confirmations to longer explanations)
- Include relevant details (amounts, dates, names, locations)

### Date Distribution
- **Recent**: Last 7 days (most common)
- **Medium**: 1-3 months ago
- **Old**: 6+ months ago (for historical queries)
- **Today**: Multiple messages throughout today
- **Realistic patterns**: Clusters around events, sparse periods

### Thread Relationships
- Use consistent `threadId` for related messages
- Natural conversation flow (introduction → follow-up → response)
- Varied thread sizes (1 message, 3-5 messages, 10+ messages)

## Adding New Fixtures

### Step 1: Choose or create a file
- If scenario exists: add to that file
- If new scenario: create new file (e.g., `travel.yaml` for trip-related emails)

### Step 2: Add messages
```yaml
messages:
  - subject: "Realistic subject line"
    fromAddress: "sender@realistic-domain.com"
    fromName: "Sender Name"
    bodyText: "Natural body text with relevant details"
    date: "-7d"  # Use relative dates
    # Optional fields as needed
    # messageId is auto-generated if not provided (use only for thread relationships)
```

### Step 3: Update loader (if needed)
- The loader (`src/ask/load-fixtures.ts`) automatically loads all YAML files
- Or update it to load multiple files if we want separate loading

### Step 4: Test
- Run `npm run eval` to verify fixtures work
- Add eval test cases that use the new fixtures

## Loader Strategy

**Current**: Single file (`eval-inbox.yaml`) loaded by `loadEvalFixtures()`

**Options for multiple files**:

1. **Merge all files** — Loader reads all `*.yaml` files and merges messages
2. **Selective loading** — Loader accepts file list, tests specify which files
3. **Layered loading** — Base file + scenario files, tests can add more

**Recommendation**: Start with option 1 (merge all) for simplicity. We can add selective loading later if needed.

## Example: Adding a New Scenario

Let's say we want to add travel-related emails:

1. Create `tests/ask/travel.yaml`:
```yaml
messages:
  - subject: "Your flight confirmation - SFO to JFK"
    fromAddress: "noreply@airline.com"
    bodyText: "Flight AA123 confirmed for March 15, 2024..."
    date: "-30d"
  
  - subject: "Hotel reservation confirmed"
    fromAddress: "reservations@hotel.com"
    bodyText: "Your stay at Grand Hotel is confirmed..."
    date: "-28d"
```

2. Update `load-fixtures.ts` to load all `*.yaml` files:
```typescript
const yamlFiles = glob.sync("tests/ask/*.yaml");
for (const file of yamlFiles) {
  const data = parseYaml(readFileSync(file, "utf-8"));
  // Merge messages...
}
```

3. Add eval test case that uses travel emails:
```typescript
{
  question: "what are my upcoming travel plans?",
  criteria: { mustInclude: ["flight", "hotel"] },
}
```

## Growth Strategy

**Phase 1 (Current)**: Single file with core scenarios
**Phase 2**: Split into 3-5 scenario files (transactional, conversations, meetings)
**Phase 3**: Add specialized files (attachments, promotional, edge cases)
**Phase 4**: Add domain-specific files (apple.yaml, amazon.yaml, etc.) if needed

Start simple, grow organically as we discover what scenarios need more coverage.
