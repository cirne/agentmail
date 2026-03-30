# Attachment Extraction Tests

Automated tests for document-to-text extraction across all supported formats.

## Running tests

```bash
npm test tests/attachments/extractors.test.ts
```

## Test fixtures (`fixtures/`)

Real-world files used for extraction testing:

| File | Source | Format | Tests |
|---|---|---|---|
| `irs-w9-form.pdf` | IRS.gov | PDF | Text extraction from a structured government form |
| `rfc-791.pdf` | IETF RFC Editor | PDF | Text extraction from a technical specification |
| `sample-doc.docx` | FreeTestData | DOCX | Markdown conversion from a Word document |
| `sales-data.xlsx` | Microsoft | XLSX | CSV conversion from a 700-row sales dataset |
| `sample-page.html` | Hand-crafted | HTML | Markdown conversion, verifies HTML tags are stripped |
| `sample-data.csv` | Hand-crafted | CSV | Passthrough (content preserved unchanged) |
| `readme.txt` | Hand-crafted | TXT | Passthrough (content preserved unchanged) |

## Manual testing

Test extraction on any file:

```bash
npx tsx tests/attachments/test-extract.ts <file-path>
```

## Test against real email attachments

After a sync, test extraction on actual email attachments:

```bash
zmail attachment list <message_id>       # find attachment IDs
zmail attachment read <attachment_id>     # extract and print to stdout
```
