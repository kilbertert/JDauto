# JDauto Domain Context

JDauto automates two distinct JD workflows: timed ordering and SKU product-data collection. This glossary keeps their language separate while documenting the browser context they share.

## Language

**Order Run**:
One account executing one configured SKU task from preparation through order submission and payment.
_Avoid_: Instance, job

**Product Capture**:
The network responses observed while opening the page for one expected JD SKU.
_Avoid_: Scrape result, raw response

**Product Record**:
A persisted product document whose top-level ID and verified detail payload belong to exactly one JD SKU.
_Avoid_: Capture, item JSON

**OpenCLI Profile**:
A named browser context that owns login state and one Browser Bridge connection.
_Avoid_: Account, Chrome profile

**Account**:
The JD user identity configured to use one OpenCLI Profile.
_Avoid_: Profile

**Runtime Config**:
The validated accounts and order tasks loaded by the CLI or desktop application.
_Avoid_: Raw JSON, settings

## Relationships

- An **Account** uses exactly one **OpenCLI Profile**
- An **Order Run** combines exactly one **Account** with one configured task
- A **Product Capture** targets exactly one expected SKU through one **OpenCLI Profile**
- A successful **Product Capture** produces exactly one **Product Record**
- **Runtime Config** contains zero or more **Accounts** and zero or more order tasks

## Example dialogue

> **Developer:** “Can one OpenCLI Profile collect two SKUs at the same time?”
> **Domain expert:** “No. Product Captures are serial within one OpenCLI Profile, and each Product Record must be verified against its expected SKU before it is saved.”

## Flagged ambiguities

- “Profile” previously referred to both an OpenCLI alias and a browser profile directory. **OpenCLI Profile** means the Browser Bridge context; `browserProfileDir` remains the browser-directory setting.
- “Instance” previously referred to both a browser process and an order execution. Use **Order Run** for the workflow and browser instance only for the process.
