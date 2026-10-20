# Security policy

## Reporting a vulnerability

Please email **sales.bydtech@gmail.com** with the details, instead of opening a
public issue. We will acknowledge the report and keep you posted on the fix.

## Scope

The journal file holds whatever records you save, in plain text: often personal
data such as names, email addresses and phone numbers. The package creates it
with mode 0600 in a folder created 0700 and never sends it anywhere. Keeping it
out of version control and container images, backing it up, and deleting records
people ask you to delete are up to you; the README lists what to do.

`fallback-journal replay --handler <module>` imports and runs the module you
name, with your permissions. Only point it at code you trust.
