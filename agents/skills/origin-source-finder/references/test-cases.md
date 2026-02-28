# Test Cases

## Case 1: Quote Origin
Input: "Find the original source of this quote: ..."
Expected:
- transcript/interview page preferred
- quote websites not treated as primary

## Case 2: Viral Screenshot
Input: "Where did this screenshot come from?"
Expected:
- extracted text fragments queried
- original page or first post candidate returned
- manipulation caveat if unverifiable

## Case 3: Statistic Source
Input: "Source for this statistic: X%"
Expected:
- official dataset/report table URL
- metric definition validated

## Case 4: Breaking News First Report
Input: "Who first reported this event?"
Expected:
- first verified publication prioritized over rumor posts

## Case 5: No Reliable Origin
Input: ambiguous repost chain
Expected:
- "no single reliable original source confirmed"
- low confidence + alternatives

## Case 6: Multi-language Claim
Input: translated claim without original text
Expected:
- English + native-term search strategy
- translation drift caveat if needed
