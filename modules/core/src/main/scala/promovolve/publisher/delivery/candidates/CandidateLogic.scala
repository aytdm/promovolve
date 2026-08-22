package promovolve.publisher.delivery.candidates

import org.slf4j.LoggerFactory
import promovolve.publisher.*
import promovolve.{ CPM, Candidate, CategoryId }

import java.time.Instant
import scala.concurrent.{ ExecutionContext, Future }

// Type alias for creative lookup (async)
type CreativeLookup = String => Future[Option[Creative]]

/**
 * Pure helper functions for candidate processing pipeline.
 *
 * Contains stateless logic extracted from AdServer for testability
 * and reuse.
 */
object CandidateLogic {

  private val log = LoggerFactory.getLogger(getClass)

  /**
   * Filter candidates by domain blocklist.
   *
   * Separates candidates into allowed and blocked based on the
   * publisher's domain blocklist configuration.
   */
  def filterByDomainBlocklist(
      candidates: Vector[Candidate],
      blocklist: Option[PublisherEntity.CachedDomainBlocklist]
  ): (Vector[Candidate], Vector[Candidate]) =
    blocklist match {
      case Some(bl) =>
        candidates.partition(c => !bl.contains(c.landingDomain))
      case None =>
        (candidates, Vector.empty)
    }

  /** Partition candidates by pre-approval status. */
  def partitionByApprovalStatus(
      candidates: Vector[Candidate]
  ): (Vector[Candidate], Vector[Candidate]) =
    candidates.partition(_.preApproved)

  /** Get unique categories from candidates. */
  def uniqueCategories(candidates: Vector[Candidate]): Vector[CategoryId] =
    candidates.map(_.category).distinct

  /**
   * Build CandidateViews from candidates with creative lookup (async).
   *
   * Filters out candidates where creative is not found or cannot participate.
   */
  def buildCandidateViews(
      candidates: Vector[Candidate],
      creativeLookup: CreativeLookup,
      categoryScores: Map[CategoryId, Double],
      classifiedAt: Instant,
      defaultScore: Double = 0.5
  )(using ec: ExecutionContext): Future[Vector[CandidateView]] =
    Future.traverse(candidates) { candidate =>
      creativeLookup(candidate.creativeId.value).map {
        case Some(creative) if creative.canParticipate =>
          Some(buildCandidateView(candidate, creative, categoryScores, classifiedAt, defaultScore))
        case _ => None
      }
    }.map(_.flatten)

  /**
   * Multiplier applied to the category score when Gemini's
   * suggestedContentCategories on the creative include the
   * publisher-page category being auctioned. 1.15 is deliberately
   * modest — Gemini is helpful but not always right, and the boost
   * primarily biases cold-start selection (where categoryScore is
   * the Beta prior in Thompson Sampling). Once a creative has
   * impression stats, the sampled Beta posterior dominates and the
   * boost fades naturally.
   */
  private val GeminiCategoryBoost = 1.15

  /**
   * Per-hop discount on categoryScore for ancestor-reached bids (see
   * Candidate.ancestorHops). Reach stays intact — only the selection
   * prior decays with taxonomy distance.
   */
  val AncestorAffinityDecay = 0.7

  /**
   * Per-hop discount for a bid that reached a page through a BROADER place
   * than the page is about (see Candidate.placeHops). Same shape and same
   * constant as the taxonomy decay: reach stays intact, only the selection
   * prior decays, so a campaign targeting Kamakura outranks one targeting
   * Japan on a Kamakura article while both stay eligible.
   */
  val PlaceAffinityDecay = 0.7

  /** Build CandidateView from candidate with creative and scores. */
  def buildCandidateView(
      candidate: Candidate,
      creative: Creative,
      categoryScores: Map[CategoryId, Double],
      classifiedAt: Instant,
      defaultScore: Double = 0.5
  ): CandidateView = {
    val rawScore = categoryScores.getOrElse(candidate.category, defaultScore)
    // Gemini-suggested categories live on the creative row from
    // category verification. When the publisher-page category
    // (candidate.category) is one the classifier flagged as a
    // strong fit for this creative, nudge categoryScore upward so
    // the creative competes harder during cold start. Clamped at
    // 1.0 because downstream code treats categoryScore as a
    // probability-shaped prior for Thompson Sampling.
    val geminiMatch = creative.suggestedContentCategories.contains(candidate.category.value)
    // ANCESTOR DECAY: a bid reached via taxonomy ancestors (page carries
    // "Food Industry", campaign targets grandparent "Business and
    // Finance") used to score as if the page were natively about the
    // ancestor — business/tech ads outcompeting food ads on food pages.
    // Each hop of distance discounts the affinity prior, so native
    // demand naturally wins selection and ancestor demand serves as
    // backfill when nothing closer is available. 0.7^hops: parent 0.7×,
    // grandparent 0.49× — strong enough to reorder, gentle enough that
    // an ancestor bid still fills an otherwise-empty slot.
    val distanceDecayed = rawScore * math.pow(AncestorAffinityDecay, candidate.ancestorHops)
    // PLACE DECAY is NOT applied here any more. It used to be
    // (0.7^candidate.placeHops), but placeHops is the distance for the page
    // whose auction produced this candidate, and the ServeIndex key
    // (site|slot) is shared by every page using that slot — so the stored
    // score carried one page's distance onto every other. The decay now
    // happens at serve, per page, in `forPage`, together with the
    // eligibility check it belongs with.
    val score = if (geminiMatch) math.min(1.0, distanceDecayed * GeminiCategoryBoost) else distanceDecayed
    if (geminiMatch && log.isDebugEnabled) {
      log.debug(
        "Gemini category boost: creative={} page-cat={} raw={} → boosted={} (suggested={})",
        candidate.creativeId.value,
        candidate.category.value,
        f"$rawScore%.3f",
        f"$score%.3f",
        creative.suggestedContentCategories.mkString(",")
      )
    }
    val serveCpm = if (candidate.maxCpm > CPM.zero) candidate.maxCpm else candidate.cpm
    CandidateView(
      creativeId = candidate.creativeId,
      campaignId = candidate.campaignId,
      advertiserId = candidate.advertiserId,
      assetUrl = CDNPath(creative.s3Key),
      mime = MimeType(creative.mime),
      width = creative.width,
      height = creative.height,
      category = candidate.category,
      cpm = serveCpm,
      classifiedAtMs = classifiedAt.toEpochMilli,
      categoryScore = score,
      adProductCategory = candidate.adProductCategory,
      landingDomain = candidate.landingDomain,
      landingUrl = creative.landingUrl,
      placeTargeting = candidate.placeTargeting
    )
  }

  /**
   * The page-side half of place targeting, applied at SERVE.
   *
   * The auction is per URL and applies `placeAdmits` correctly, but the
   * ServeIndex is keyed by site|slot and a slot id is shared by every page
   * that uses it (the WordPress plugin's per-category slots, by design). So
   * the candidates a page reads were not necessarily won on THAT page: a
   * campaign targeting Kanazawa wins the Kanazawa article, lands in the
   * `…-travel` slot's pool, and is then served — and billed — on the Tainan
   * article that shares the slot (live, 2026-08-22). Place targeting was
   * enforced at auction and leaked at serve.
   *
   * This re-applies it against the page actually being served:
   *
   *   - a candidate whose targeting does not admit `pagePlaces` is dropped;
   *     untargeted candidates (empty set) pass, as they bid everywhere;
   *   - the surviving ones get the relevance decay for THIS page's distance
   *     (0.7^hops) — the same constant as before, now computed where the
   *     page is known rather than baked in at auction for a different page.
   *
   * `pagePlaces` empty means "this page is about nowhere we know" — classified
   * that way, or never auctioned on this AdServer incarnation — and a
   * targeted candidate is dropped for it, exactly as the campaign would have
   * declined to bid. Advertiser-protective by construction: the cost of a
   * wrong "drop" is one missed impression; the cost of a wrong "keep" is a
   * billed impression the advertiser never asked for.
   */
  def forPage(candidates: Vector[CandidateView], pagePlaces: Set[String]): Vector[CandidateView] =
    candidates.flatMap { c =>
      if (c.placeTargeting.isEmpty) Some(c)
      else
        promovolve.taxonomy.Places.matchHops(c.placeTargeting, pagePlaces).map { hops =>
          if (hops == 0) c
          else c.copy(categoryScore = c.categoryScore * math.pow(PlaceAffinityDecay, hops))
        }
    }

  /** Create a ServeView from candidate views. */
  def buildServeView(
      candidateViews: Vector[CandidateView],
      ttlMs: Long,
      nowMs: Long = System.currentTimeMillis()
  ): ServeView =
    ServeView(
      candidates = candidateViews,
      version = nowMs,
      expiresAtMs = nowMs + ttlMs
    )

  /** Get blocked domain names from filtered candidates. */
  def blockedDomains(blocked: Vector[Candidate]): Seq[String] =
    blocked.map(_.landingDomain).distinct

  /** Check if any candidates have creatives that can participate (async). */
  def hasAnyCreatives(
      candidates: Vector[Candidate],
      creativeLookup: CreativeLookup
  )(using ec: ExecutionContext): Future[Boolean] =
    Future.traverse(candidates) { c =>
      creativeLookup(c.creativeId.value).map(_.exists(_.canParticipate))
    }.map(_.exists(identity))
}
