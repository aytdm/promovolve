package promovolve.publisher.delivery.pacing

import promovolve.CampaignId
import promovolve.common.Timezones
import promovolve.publisher.CandidateView
import promovolve.publisher.delivery.Protocol.CachedSpendInfo
import promovolve.publisher.delivery.{ AdaptivePacing, FixedThrottlePacing, PacingStrategy, TrafficShapeTracker }
import promovolve.publisher.SiteEntity

import java.time.{ Instant, ZoneOffset }

/**
 * Pure helper functions for pacing computations.
 *
 * Contains stateless logic extracted from AdServer for testability
 * and reuse. All functions are pure - no side effects.
 */
object PacingLogic {

  /**
   * Compute average CPM per campaign from candidates.
   *
   * Groups candidates by campaign and calculates the mean CPM for each.
   * Used for weighted budget calculations in aggregate pacing.
   *
   * @param candidates  All candidates in the selection pool
   * @param defaultCpm  Default CPM if a campaign has no valid CPMs (default 5.0)
   * @return Map from campaign ID to average CPM
   */
  def computeCpmByCampaign(
      candidates: Vector[CandidateView],
      defaultCpm: Double = 5.0
  ): Map[CampaignId, Double] =
    candidates.groupBy(_.campaignId).view.mapValues { cands =>
      val cpms = cands.map(_.cpm.toDouble)
      if (cpms.nonEmpty) cpms.sum / cpms.size else defaultCpm
    }.toMap

  /**
   * Campaigns still able to spend today: todaySpend < dailyBudget.
   *
   * Exhausted campaigns deliberately KEEP their ServeIndex entries (approval
   * preservation — see AuctioneerEntity's budget-exhaustion flow) and their
   * spendInfoCache entries, so without this filter a spent-out campaign sits
   * in the pacing aggregate all day contributing todaySpend == dailyBudget
   * against an expected spend of only dailyBudget × f — phantom over-pace
   * that throttles the campaigns still live (issue #8 F1). Apply this ONCE,
   * upstream of EVERY consumer of the aggregate (computeAggregateBudget,
   * the dayStart anchor, computeAggregateExpectedSpend): filtering only the
   * spend sums while the expected side still counts exhausted budgets would
   * bias the ratio the other way.
   *
   * An empty result with a non-empty input means the whole pool is spent —
   * callers should refuse the serve outright (TryReserve would deny every
   * candidate anyway) rather than fail open.
   *
   * "Able to spend" is FUNCTIONAL, not exact: campaigns exhaust with dust
   * left (remaining < the price of any single impression — observed live as
   * `TryReserve DENIED … remaining=0.0022` all day), so a strict
   * `todaySpend < dailyBudget` never fires in practice. A campaign is live
   * only while it can still afford one impression at its own cheapest CPM;
   * campaigns with no CPM entry (not in the current candidate pool's map)
   * fall back to the strict check.
   */
  def liveInfos(
      infos: Seq[(CampaignId, CachedSpendInfo)],
      minCpmByCampaign: Map[CampaignId, Double] = Map.empty
  ): Seq[(CampaignId, CachedSpendInfo)] =
    infos.filter { case (campId, info) =>
      val minImpCost = BigDecimal(minCpmByCampaign.getOrElse(campId, 0.0) / 1000.0)
      info.todaySpend.value + minImpCost < info.dailyBudget.value
    }

  /**
   * Cheapest CPM per campaign in the candidate pool — the cost floor of one
   * impression, used by [[liveInfos]] to detect functional exhaustion.
   */
  def minCpmByCampaign(candidates: Vector[CandidateView]): Map[CampaignId, Double] =
    candidates.groupBy(_.campaignId).view.mapValues { cands =>
      cands.map(_.cpm.toDouble).min
    }.toMap

  /**
   * Each campaign's OWN pace ratio: (spend + pending) / expected spend by
   * now (issue #8 F3). The site gate regulates the pool's total volume but
   * is blind to the split — a campaign that keeps winning front-loads while
   * a small one next to a whale is arithmetically invisible. These ratios
   * drive a per-campaign pass filter on the eligible candidates: ratio <= 1
   * always passes; ratio r > 1 passes with probability 1/r (proportional
   * slowdown, never a hard cut). Campaigns absent from `infos` (no spend
   * info) must FAIL OPEN at the caller — filtering on cache PRESENCE is the
   * d4ae4e5 doom loop; filtering on a KNOWN pace ratio is not.
   *
   * Denominator carries the same slack floor as PacingContext.spendRatio
   * (1% of budget, min 1 cent) so a sleeping traffic shape reads as
   * under-paced rather than exploding the ratio at day start.
   *
   * Zone-aware real days use each campaign's own advertiser-zone window
   * fraction; otherwise the pool's expected-spend fraction applies to all.
   */
  def perCampaignPaceRatios(
      infos: Seq[(CampaignId, CachedSpendInfo)],
      pendingSpend: Map[CampaignId, (Double, Instant)],
      tracker: TrafficShapeTracker,
      now: Instant,
      zoneAware: Boolean,
      dayDurationSeconds: Int,
      poolFraction: Double
  ): Map[CampaignId, Double] =
    infos.map { case (campId, info) =>
      val fraction =
        if (zoneAware && dayDurationSeconds == 86400)
          expectedWindowFraction(tracker, info.dayStart, windowEndFor(info.dayStart, info.timezone), now)
        else poolFraction
      val slack = (info.dailyBudget.value * 0.01).max(BigDecimal(0.01))
      val denom = (info.dailyBudget.value * BigDecimal(fraction)).max(slack)
      val spent =
        info.todaySpend.value + BigDecimal(pendingSpend.get(campId).map(_._1).getOrElse(0.0))
      (campId, (spent / denom).toDouble)
    }.toMap

  /**
   * Compute aggregate budget metrics for pacing decisions.
   *
   * Calculates total daily budget, total spend (including pending),
   * and CPM-weighted average for the pool of campaigns.
   *
   * The weighted average CPM accounts for the fact that higher-CPM campaigns
   * will deliver fewer impressions per dollar of budget.
   *
   * @param validInfos    Sequence of (campaignId, spendInfo) pairs with valid data
   * @param cpmByCampaign Map of average CPM per campaign
   * @param pendingSpend  Map of uncommitted spend per campaign
   * @return Tuple of (totalDailyBudget, totalTodaySpend, weightedAvgCpm)
   */
  def computeAggregateBudget(
      validInfos: Seq[(CampaignId, CachedSpendInfo)],
      cpmByCampaign: Map[CampaignId, Double],
      pendingSpend: Map[CampaignId, (Double, java.time.Instant)]
  ): (BigDecimal, BigDecimal, Double) = {
    val totalDailyBudget = validInfos.map(_._2.dailyBudget.value).sum
    val totalTodaySpend = validInfos.map { case (campId, info) =>
      info.todaySpend.value + BigDecimal(pendingSpend.get(campId).map(_._1).getOrElse(0.0))
    }.sum

    // CPM-weighted expected spend calculation
    val avgCpm = computeWeightedAvgCpm(validInfos, cpmByCampaign, totalDailyBudget)
    (totalDailyBudget, totalTodaySpend, avgCpm)
  }

  /**
   * Compute CPM-weighted average across campaigns.
   *
   * This weights each campaign's CPM by its expected impression share,
   * giving a more accurate aggregate CPM for pacing calculations.
   *
   * @param validInfos       Campaign spend info
   * @param cpmByCampaign    CPM per campaign
   * @param totalDailyBudget Total budget (pre-computed for efficiency)
   * @return Weighted average CPM
   */
  def computeWeightedAvgCpm(
      validInfos: Seq[(CampaignId, CachedSpendInfo)],
      cpmByCampaign: Map[CampaignId, Double],
      totalDailyBudget: BigDecimal
  ): Double = {
    val totalExpectedImpressions = validInfos.map { case (campId, info) =>
      val cpm = cpmByCampaign.getOrElse(campId, 5.0)
      if (cpm > 0) (info.dailyBudget.value.toDouble / cpm) * 1000.0 else 0.0
    }.sum

    if (totalExpectedImpressions > 0 && totalDailyBudget > 0)
      totalDailyBudget.toDouble / totalExpectedImpressions * 1000.0
    else {
      val cpms = validInfos.map { case (campId, _) => cpmByCampaign.getOrElse(campId, 5.0) }
      if (cpms.nonEmpty) cpms.sum / cpms.size else 5.0
    }
  }

  /**
   * Convert SiteEntity pacing config to PacingStrategy.
   *
   * Handles three cases:
   * 1. Test override: Fixed throttle probability for testing
   * 2. Shape-aware: Uses configured hourly volume shapes
   * 3. Default: Adaptive pacing with default parameters
   *
   * @param config Pacing configuration from SiteEntity
   * @return Appropriate PacingStrategy instance
   */
  def strategyFromConfig(config: SiteEntity.PacingConfig): PacingStrategy =
    config.testThrottleOverride match {
      case Some(fixedProb) =>
        // For testing: use fixed throttle probability
        FixedThrottlePacing(fixedProb)
      case None =>
        // Normal operation: adaptive pacing (traffic shape is always learned)
        AdaptivePacing()
    }

  /**
   * Calculate spend ratio (spend / budget).
   *
   * Returns 0.0 if budget is zero to avoid division by zero.
   *
   * @param totalSpend  Total spend so far
   * @param totalBudget Total daily budget
   * @return Spend ratio between 0.0 and potentially > 1.0 if overspent
   */
  def spendRatio(totalSpend: BigDecimal, totalBudget: BigDecimal): Double =
    if (totalBudget > 0) (totalSpend / totalBudget).toDouble else 0.0

  /**
   * Check if spend ratio exceeds a threshold.
   *
   * Useful for early-out checks before computing full pacing.
   *
   * @param spendRatio Current spend / budget ratio
   * @param threshold  Maximum acceptable ratio (default 1.0)
   * @return true if spend exceeds threshold
   */
  def isOverBudget(spendRatio: Double, threshold: Double = 1.0): Boolean =
    spendRatio >= threshold

  /**
   * Calculate seconds elapsed in the pacing day.
   *
   * @param dayStart Start of the pacing day
   * @param now      Current time
   * @return Seconds elapsed since day start
   */
  def elapsedSeconds(dayStart: Instant, now: Instant): Double =
    java.time.Duration.between(dayStart, now).toMillis / 1000.0

  // ═══════════════════════════════════════════════════════════════════════
  // ADVERTISER-TIMEZONE BUDGET WINDOWS (real calendar days only)
  //
  // The traffic shape stays a UTC hour-of-day curve (it's the SITE's
  // observed volume — a global-audience site has no single zone). Each
  // campaign's budget window is [dayStart, next advertiser-zone midnight),
  // which for a non-UTC advertiser WRAPS the UTC day boundary, so expected
  // spend integrates the UTC curve across that wrap.
  // ═══════════════════════════════════════════════════════════════════════

  /** End of a campaign's budget window: next advertiser-zone midnight after dayStart. */
  def windowEndFor(dayStart: Instant, timezone: String): Instant =
    Timezones.nextMidnightAfter(dayStart, timezone)

  /**
   * True when a cached spend entry's budget window has already ENDED — the
   * entry describes a finished day and is stale by definition, whatever its
   * cache timestamp says. Feeding it forward drives `remainingHours` to 0
   * and the pacing hard stop refuses every serve, while the SpendUpdate
   * that would refresh the entry mostly rides on serving — the 2026-08-16
   * midnight latch. Callers treat such entries as cache MISSES (refetch
   * the campaign's real, rolled dayStart) instead of trusting them.
   */
  def windowExpired(info: CachedSpendInfo, now: Instant): Boolean =
    !windowEndFor(info.dayStart, info.timezone).isAfter(now)

  /** Seconds into the UTC day of `instant` (traffic-shape bucket coordinate). */
  def secOfUtcDay(instant: Instant): Double =
    instant.atZone(ZoneOffset.UTC).toLocalTime.toSecondOfDay.toDouble

  /**
   * Traffic-shape mass over a possibly-midnight-wrapping interval of the UTC
   * day. `fullDay` short-circuits to 1.0 — needed because an interval
   * spanning the whole 24h cycle has fromSec == toSec, which the wrap
   * formula would misread as an empty interval.
   */
  def wrappedMass(
      tracker: TrafficShapeTracker,
      fromSec: Double,
      toSec: Double,
      fullDay: Boolean
  ): Double =
    if (fullDay) 1.0
    else if (toSec >= fromSec)
      tracker.cumulativeFractionAtTime(toSec) - tracker.cumulativeFractionAtTime(fromSec)
    else
      (1.0 - tracker.cumulativeFractionAtTime(fromSec)) + tracker.cumulativeFractionAtTime(toSec)

  /**
   * Expected fraction of a campaign's budget spent by `now`, integrating the
   * UTC traffic shape over the campaign's budget window.
   *
   * For a UTC advertiser this is algebraically identical to the legacy
   * remaining-hours formula in [[promovolve.publisher.delivery.PacingContext]]
   * (windowEnd at UTC midnight makes the denominator `1 - CDF(start)`).
   *
   * Known accepted approximations (bounded, documented):
   *   - a wrapped window can straddle a weekday/weekend shape flip; the
   *     tracker's currentShape is single-day-type.
   *   - on a DST-change day a zone's "day" is 23h/25h; the fullDay guard and
   *     second-of-day coordinates treat it as 24h, mis-weighting at most the
   *     lapped hour once or twice a year.
   */
  def expectedWindowFraction(
      tracker: TrafficShapeTracker,
      dayStart: Instant,
      windowEnd: Instant,
      now: Instant
  ): Double =
    if (!now.isBefore(windowEnd)) 1.0
    else if (!now.isAfter(dayStart)) 0.0
    else {
      // dayStart at (or within seconds of) the zone midnight ⇒ the window is
      // the full 24h cycle and from/to coincide — mass is 1, not 0.
      val fullDay = java.time.Duration.between(dayStart, windowEnd).getSeconds >= 86395L
      val fromSec = secOfUtcDay(dayStart)
      val denom = wrappedMass(tracker, fromSec, secOfUtcDay(windowEnd), fullDay)
      if (denom < 0.001) {
        // Degenerate: near-zero shape mass in the window — fall back to
        // linear-in-window (zone-safe by construction).
        val total = java.time.Duration.between(dayStart, windowEnd).toMillis.toDouble
        if (total <= 0) 1.0
        else math.min(1.0, java.time.Duration.between(dayStart, now).toMillis.toDouble / total)
      } else
        math.min(1.0, wrappedMass(tracker, fromSec, secOfUtcDay(now), fullDay = false) / denom)
    }

  /**
   * Aggregate expected spend across campaigns whose budget windows may sit in
   * DIFFERENT advertiser zones, plus the latest window end.
   *
   * Replaces the single-dayStart `dailyBudget × expectedSpendFraction`: with
   * mixed zones there is no one day window, so each campaign contributes its
   * own `budget × expectedWindowFraction`, and the pacing hard-stop horizon
   * is the LAST window end (the site must not hard-stop while any campaign
   * still has budget-day left).
   *
   * @return (expected aggregate spend, max window end across campaigns)
   */
  def computeAggregateExpectedSpend(
      validInfos: Seq[(CampaignId, CachedSpendInfo)],
      tracker: TrafficShapeTracker,
      now: Instant
  ): (BigDecimal, Instant) = {
    var expected = BigDecimal(0)
    var maxWindowEnd = now
    validInfos.foreach { case (_, info) =>
      val windowEnd = windowEndFor(info.dayStart, info.timezone)
      expected += info.dailyBudget.value *
      BigDecimal(expectedWindowFraction(tracker, info.dayStart, windowEnd, now))
      if (windowEnd.isAfter(maxWindowEnd)) maxWindowEnd = windowEnd
    }
    (expected, maxWindowEnd)
  }
}
