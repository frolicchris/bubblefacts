/**
 * Grounding and screening.
 *
 * Grounding fetches the song's Wikipedia article so the model restates a
 * source instead of recalling from memory. Screening then drops any sentence
 * whose names, years or platforms the source does not contain. Every check
 * is a string comparison: no second model, no added latency.
 *
 * The code lives in `grounding/` and `screening/` (see the module map in
 * docs/ARCHITECTURE.md). This file re-exports what callers use, so they
 * import from one place.
 */

export { MAX_CONTEXT_CHARS, MAX_FACT_CHARS, MIN_CONTEXT_CHARS } from "./fact-limits";
export { artistNames, dropVersionTags, foldSymbols, mentionsName, normalizeKeys, normalizeTitle, parseClassicalTitle, resolveGameAndTrack, splitGameAndTrack } from "./grounding/titles";
export type { ClassicalTitle } from "./grounding/titles";
export { editionNotInTitle, initialsDiffer, isRelevantArticle, isInitials, looksLikeArtistName, namesLoosely, numeralStyleDiffers, qualifierNamesAnotherArtist } from "./grounding/relevance";
export { creatorSentences, isDisambiguation, orderExtract, ownArticleExtract, receptionSentences, rememberArticle, settledRevision, STABLE_AGE_MS, theorySentences, USER_AGENT, wikiExtract, withoutVideoSections, withSearches } from "./grounding/wikipedia";
export { notForStream, platformSupported, unsupportedCredit, unsupportedName, unsupportedWinner } from "./screening/names";
export { alteredQuote, explainMusicTerms, restatesRequest, supportingSentence, tooSimilar } from "./screening/similarity";
export { lostQualifier, numberedReference, referenceSentences, retoldSentences, support, unsupportedConnective, unsupportedRelation } from "./screening/sentences";
export { citedMismatch, droppedYear, misattributedWords, otherDoer, swappedSubject, unattributedView, unsupportedDay } from "./screening/attribution";
export { droppedFrame, droppedLimit, leftBehindReferent, movedChartDetail, unnamedChart, unnamedReference } from "./screening/frames";
export { droppedHedge, mergedClauses, misplacedYear, otherRecordingSection, reversedRole, suppliedException, turnedRound, wrongOwner } from "./screening/wording";
export { qualifierRepair, repairQualifier, repairScope, scopeRepair } from "./screening/repair";
export { companyHistory, parseCitation, screenClaims, unresolvedPronoun } from "./screening/screen";
export type { ScreenResult } from "./screening/screen";
export { composerNames, isChartFact, isCleanSentence, keepsAttribution, receptionFilter, sectionExtract, sectionSelection, selectSections, seriesFilter, tieredExtract, tieredSelection, withoutSentences } from "./grounding/sections";
export { italicSentences, loadWikitext, otherWorkSentences, requestedWork, wikitextOf, workOfPage, workScope } from "./grounding/work-scope";
export type { ItalicSentence } from "./grounding/work-scope";
export { articleMisfit, articleText, coverScope, isCoverOf, isPieceArticle, isPlaceholderRequest, openingSays, opensAboutMusicOrWork, originalsRecord, otherVersionsRecord, requestNames, selectedText } from "./grounding/covers";
export type { GameArticles } from "./grounding/covers";
export { describedKind, gameInsteadOfScreen, gameTrackText, isMusicArticleFor, isScreenPage, isSeriesWide, namesPiece, namesThisGame, oneOfSeveral, otherParts, pageSummary, seriesScope, soundtrackPart, summaryGate, summaryMismatch, trackSentences } from "./grounding/summary";
export type { DescribedKind, PageSummary } from "./grounding/summary";
export { editDistance } from "./text";
export { isRespelling, isSameWorkRedirect, lookupForm, readings, workFromTitle } from "./grounding/readings";
export type { Reading } from "./grounding/readings";
export { isNonMusicWork, isPerformerArticle, isWorkArticle, workMatchConfidence } from "./grounding/work-match";
export type { WorkMatch } from "./grounding/work-match";
export { movementSection, namesOneWork, nameWords, notForAPiece, pickWork, pieceSection, workFits, workQueries } from "./grounding/classical-works";
export type { WorkFit } from "./grounding/classical-works";
export { COMPANION_LABEL, companionOf, companionPages, companionSentences, MIN_MAKING_SENTENCES, withoutBlockedCompanions } from "./grounding/companion";
export { isConcertFilm, leadNamesPerformer, listedTracks, performerPages } from "./grounding/performer-name";
export { ownMusicParts, themeOf } from "./grounding/theme";
export { clearGroundingCache, fetchGrounding } from "./grounding/lookup";
export { CURATED_REST_MS, curatedFacts, resetCuratedTurns } from "./curated-facts";
