# Header link, Solana risk and report history fixes

The circular link/share button is removed from the app and New pairs headers. The landing page has no such button. Copy this check and the report's Copy link remain available.

Solana safety now uses the Base score ring, number animation and grouped finding rows in both the app and token report. Each render starts the arc empty and number at zero; the existing 900ms Base animation reaches the actual score. Reduced-motion preference shows the final result immediately. Unknown checks have a separate group and are never marked checked/clear. All-unknown input has no numeric score.

The score is an explicitly labelled heuristic for token-control flags, not a probability of loss. Active mint/freeze/fee-setting authorities add 12 each. A positive transfer fee adds 5 (12 above 5%). Largest-account concentration adds 5 above 50% (12 above 80%), with an explicit pools/custody caveat. Active permanent delegate and non-transferability add 25 each; frozen default accounts add 12. The sum is capped at 100. Unknown/unreviewed extension behavior is shown separately without inventing a score contribution. Metadata/group extensions are not treated as intrinsic risk. The score does not claim a guarantee of sellability.

The SPA previously pushed a /app entry when leaving /t/... without restoring the token report on popstate. Returning across the report/app boundary now reloads the route from its actual URL, and hashchange cannot overwrite the history while that restoration is pending. Browser Back returns to the check report and Forward returns to the swap.

Validation: 49 unit/server tests passed; dedicated browser checks passed for score/grouping, arc and number starting at zero, final score, reduced motion, report Trade/Back/Forward, and 360/375/390/430/768/1280 layouts in both themes. The full web/test/run.py regression also passed with no browser console errors, including Base report Trade/Back/Forward. The local test server now mirrors the production /app route so Forward reloads the same application document. Public deployment checks are recorded separately. No real wallet transaction was sent.

Primary references: https://solana.com/docs/tokens/basics and https://solana.com/docs/tokens/extensions/permanent-delegate. The risk weights are site heuristics, not Solana protocol risk ratings.
