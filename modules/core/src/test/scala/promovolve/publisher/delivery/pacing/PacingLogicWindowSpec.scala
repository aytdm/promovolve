package promovolve.publisher.delivery.pacing

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import promovolve.{ AdvertiserId, Budget, CampaignId, Spend }
import promovolve.publisher.delivery.Protocol.CachedSpendInfo
import promovolve.publisher.delivery.TrafficShapeTracker

import java.time.Instant

/**
 * Pure tests for the advertiser-timezone budget-window helpers in
 * [[PacingLogic]]: window ends at the advertiser zone's next midnight, so a
 * non-UTC window WRAPS the UTC day boundary and expected spend integrates the
 * (UTC hour-of-day) traffic shape across that wrap. No actors involved.
 */
class PacingLogicWindowSpec extends AnyFlatSpec with Matchers {

  private val Tolerance = 1e-9

  /** Fresh tracker: buckets initialize to 1.0 each, so the CDF is linear. */
  private def uniformTracker: TrafficShapeTracker = TrafficShapeTracker()

  /** Deterministic non-uniform shape (restore bypasses EMA learning). */
  private def skewedTracker: TrafficShapeTracker = {
    val t = new TrafficShapeTracker(bucketCount = 24, alpha = 1.0)
    t.restore(Array.tabulate(24)(i => 0.25 + (i % 7).toDouble))
    t
  }

  /** The legacy UTC-day formula from PacingContext.expectedSpendFraction. */
  private def legacyFraction(tracker: TrafficShapeTracker, startSec: Double, nowSec: Double): Double = {
    val startCdf = tracker.cumulativeFractionAtTime(startSec)
    val currentCdf = tracker.cumulativeFractionAtTime(nowSec)
    val remaining = 1.0 - startCdf
    if (remaining > 0.001) (currentCdf - startCdf) / remaining else 0.0
  }

  // ==================== secOfUtcDay ====================

  "secOfUtcDay" should "return seconds into the UTC day" in {
    PacingLogic.secOfUtcDay(Instant.parse("2026-07-13T00:00:00Z")) shouldBe 0.0
    PacingLogic.secOfUtcDay(Instant.parse("2026-07-13T01:00:00Z")) shouldBe 3600.0
    PacingLogic.secOfUtcDay(Instant.parse("2026-07-13T12:30:15Z")) shouldBe (12 * 3600 + 30 * 60 + 15).toDouble
    PacingLogic.secOfUtcDay(Instant.parse("2026-07-13T23:59:59Z")) shouldBe 86399.0
  }

  // ==================== windowEndFor ====================

  "windowEndFor" should "end a UTC window at the next UTC midnight" in {
    PacingLogic.windowEndFor(Instant.parse("2026-07-13T11:00:00Z"), "") shouldBe
    Instant.parse("2026-07-14T00:00:00Z")
  }

  it should "end a JST window at the next JST midnight (15:00Z)" in {
    // 2026-07-13T15:00Z == 2026-07-14T00:00 JST, so the next JST midnight is
    // exactly 24h later.
    PacingLogic.windowEndFor(Instant.parse("2026-07-13T15:00:00Z"), "Asia/Tokyo") shouldBe
    Instant.parse("2026-07-14T15:00:00Z")
    PacingLogic.windowEndFor(Instant.parse("2026-07-13T16:30:00Z"), "Asia/Tokyo") shouldBe
    Instant.parse("2026-07-14T15:00:00Z")
  }

  // ==================== windowExpired ====================

  private def cachedInfo(dayStart: Instant, tz: String): CachedSpendInfo =
    CachedSpendInfo(
      advertiserId = AdvertiserId("adv"),
      dailyBudget = Budget(100.0),
      todaySpend = Spend(1.0),
      dayStart = dayStart,
      timestamp = dayStart,
      timezone = tz
    )

  // The 2026-08-16 midnight latch scenario: a JST entry stamped at 14:36Z
  // has a window ending 24 minutes later (15:00Z = JST midnight). At and
  // after that boundary the entry is stale and must read as expired so the
  // pacing gate refetches instead of hard-stopping on remainingHours=0.
  "windowExpired" should "be false while the entry's zone window is still open" in {
    val info = cachedInfo(Instant.parse("2026-08-16T14:36:14Z"), "Asia/Tokyo")
    PacingLogic.windowExpired(info, Instant.parse("2026-08-16T14:59:59Z")) shouldBe false
  }

  it should "be true exactly at the zone-midnight window end, and after" in {
    val info = cachedInfo(Instant.parse("2026-08-16T14:36:14Z"), "Asia/Tokyo")
    PacingLogic.windowExpired(info, Instant.parse("2026-08-16T15:00:00Z")) shouldBe true
    PacingLogic.windowExpired(info, Instant.parse("2026-08-16T15:22:00Z")) shouldBe true
  }

  it should "keep a freshly rolled entry live for its full new day" in {
    // Entry rolled at JST midnight: window ends at the NEXT JST midnight.
    val info = cachedInfo(Instant.parse("2026-08-16T15:00:00Z"), "Asia/Tokyo")
    PacingLogic.windowExpired(info, Instant.parse("2026-08-16T15:22:00Z")) shouldBe false
    PacingLogic.windowExpired(info, Instant.parse("2026-08-17T14:59:59Z")) shouldBe false
    PacingLogic.windowExpired(info, Instant.parse("2026-08-17T15:00:00Z")) shouldBe true
  }

  it should "use UTC midnight for the default zone" in {
    val info = cachedInfo(Instant.parse("2026-07-13T11:00:00Z"), "")
    PacingLogic.windowExpired(info, Instant.parse("2026-07-13T23:59:59Z")) shouldBe false
    PacingLogic.windowExpired(info, Instant.parse("2026-07-14T00:00:00Z")) shouldBe true
  }

  // ==================== wrappedMass ====================

  "wrappedMass" should "reduce to a plain CDF difference when the interval does not wrap" in {
    val t = new TrafficShapeTracker(bucketCount = 4, alpha = 1.0)
    t.restore(Array(1.0, 2.0, 3.0, 4.0)) // CDF at bucket starts: [0, 0.1, 0.3, 0.6]
    PacingLogic.wrappedMass(t, 21600.0, 64800.0, fullDay = false) shouldBe 0.5 +- Tolerance
  }

  it should "compute (1 - CDF(from)) + CDF(to) on the wrap branch" in {
    val t = new TrafficShapeTracker(bucketCount = 4, alpha = 1.0)
    t.restore(Array(1.0, 2.0, 3.0, 4.0))
    // from = start of bucket 3 (CDF 0.6), to = start of bucket 1 (CDF 0.1)
    PacingLogic.wrappedMass(t, 64800.0, 21600.0, fullDay = false) shouldBe (0.4 + 0.1) +- Tolerance
  }

  it should "short-circuit to 1.0 for a full-day interval (from == to would misread as empty)" in {
    PacingLogic.wrappedMass(uniformTracker, 54000.0, 54000.0, fullDay = true) shouldBe 1.0
    PacingLogic.wrappedMass(skewedTracker, 0.0, 0.0, fullDay = true) shouldBe 1.0
  }

  // ==================== expectedWindowFraction: UTC equivalence ====================

  "expectedWindowFraction" should "match the legacy remaining-hours formula for a UTC advertiser (uniform shape)" in {
    val tracker = uniformTracker
    val dayStart = Instant.parse("2024-06-01T11:00:00Z")
    val windowEnd = PacingLogic.windowEndFor(dayStart, "")
    val startSec = PacingLogic.secOfUtcDay(dayStart)
    for (h <- 1 to 12) {
      val now = dayStart.plusSeconds(h * 3600L)
      val expected = legacyFraction(tracker, startSec, PacingLogic.secOfUtcDay(now))
      PacingLogic.expectedWindowFraction(tracker, dayStart, windowEnd, now) shouldBe expected +- Tolerance
    }
  }

  it should "match the legacy remaining-hours formula for a UTC advertiser (skewed shape)" in {
    val tracker = skewedTracker
    val dayStart = Instant.parse("2024-06-01T11:00:00Z")
    val windowEnd = PacingLogic.windowEndFor(dayStart, "")
    val startSec = PacingLogic.secOfUtcDay(dayStart)
    for (h <- 1 to 12) {
      val now = dayStart.plusSeconds(h * 3600L)
      val expected = legacyFraction(tracker, startSec, PacingLogic.secOfUtcDay(now))
      PacingLogic.expectedWindowFraction(tracker, dayStart, windowEnd, now) shouldBe expected +- Tolerance
    }
  }

  // ==================== expectedWindowFraction: wrapped JST window ====================

  it should "integrate the shape across the UTC midnight wrap for a JST window" in {
    val tracker = uniformTracker
    val dayStart = Instant.parse("2026-07-13T15:00:00Z") // JST midnight
    val windowEnd = PacingLogic.windowEndFor(dayStart, "Asia/Tokyo")
    windowEnd shouldBe Instant.parse("2026-07-14T15:00:00Z")

    // 0.0 exactly at the window start.
    PacingLogic.expectedWindowFraction(tracker, dayStart, windowEnd, dayStart) shouldBe 0.0

    // Monotonically nondecreasing hour by hour across the UTC midnight.
    val fractions = (0 to 24).map { h =>
      PacingLogic.expectedWindowFraction(tracker, dayStart, windowEnd, dayStart.plusSeconds(h * 3600L))
    }
    fractions.sliding(2).foreach { case Seq(a, b) => b should be >= a }

    // Uniform shape: halfway through the (wrapped) window is 0.5.
    PacingLogic.expectedWindowFraction(
      tracker, dayStart, windowEnd, dayStart.plusSeconds(12 * 3600L)
    ) shouldBe 0.5 +- Tolerance

    // 1.0 at and after the window end.
    PacingLogic.expectedWindowFraction(tracker, dayStart, windowEnd, windowEnd) shouldBe 1.0
    PacingLogic.expectedWindowFraction(tracker, dayStart, windowEnd, windowEnd.plusSeconds(3600)) shouldBe 1.0
  }

  it should "treat a window starting exactly at zone midnight as a full day (no 0/NaN denominator)" in {
    val tracker = uniformTracker
    val dayStart = Instant.parse("2026-07-13T15:00:00Z") // exactly JST midnight
    val windowEnd = PacingLogic.windowEndFor(dayStart, "Asia/Tokyo")
    // from == to in shape coordinates; the fullDay guard must make the
    // denominator 1.0 rather than the empty-interval reading (0 → NaN/∞).
    val f = PacingLogic.expectedWindowFraction(tracker, dayStart, windowEnd, dayStart.plusSeconds(6 * 3600L))
    f.isNaN shouldBe false
    f shouldBe 0.25 +- Tolerance
  }

  it should "clamp to 0.0 before the window and 1.0 after it" in {
    val tracker = skewedTracker
    val dayStart = Instant.parse("2026-07-13T15:00:00Z")
    val windowEnd = PacingLogic.windowEndFor(dayStart, "Asia/Tokyo")
    PacingLogic.expectedWindowFraction(tracker, dayStart, windowEnd, dayStart.minusSeconds(3600)) shouldBe 0.0
    PacingLogic.expectedWindowFraction(tracker, dayStart, windowEnd, windowEnd.plusSeconds(1)) shouldBe 1.0
  }

  // ==================== computeAggregateExpectedSpend ====================

  private def spendInfo(dayStart: Instant, budget: Double, timezone: String): CachedSpendInfo =
    CachedSpendInfo(
      advertiserId = AdvertiserId("adv-1"),
      dailyBudget = Budget(budget),
      todaySpend = Spend.zero,
      dayStart = dayStart,
      timestamp = dayStart,
      timezone = timezone
    )

  "computeAggregateExpectedSpend" should
  "sum per-window expectations for mixed zones and return the latest window end" in {
    val tracker = uniformTracker
    val utcStart = Instant.parse("2026-07-13T00:00:00Z") // UTC midnight → full-day window
    val jstStart = Instant.parse("2026-07-13T15:00:00Z") // JST midnight → wrapped full-day window
    val now = Instant.parse("2026-07-13T18:00:00Z")

    val infos = Seq(
      CampaignId("c-utc") -> spendInfo(utcStart, budget = 100.0, timezone = ""),
      CampaignId("c-jst") -> spendInfo(jstStart, budget = 50.0, timezone = "Asia/Tokyo")
    )

    val (expected, maxWindowEnd) = PacingLogic.computeAggregateExpectedSpend(infos, tracker, now)

    // UTC campaign: 18h of a uniform 24h window → 0.75 × 100 = 75.
    // JST campaign: 3h of a uniform 24h window → 0.125 × 50 = 6.25.
    expected.toDouble shouldBe 81.25 +- Tolerance
    // The pacing hard-stop horizon is the LAST window end.
    maxWindowEnd shouldBe Instant.parse("2026-07-14T15:00:00Z")
  }

  it should "count a campaign whose window has ended at its full budget" in {
    val tracker = uniformTracker
    val utcStart = Instant.parse("2026-07-13T00:00:00Z")
    val now = Instant.parse("2026-07-14T02:00:00Z") // past the UTC window end

    val infos = Seq(CampaignId("c-utc") -> spendInfo(utcStart, budget = 40.0, timezone = ""))
    val (expected, maxWindowEnd) = PacingLogic.computeAggregateExpectedSpend(infos, tracker, now)

    expected.toDouble shouldBe 40.0 +- Tolerance
    // Window end is in the past, so `now` is the max horizon.
    maxWindowEnd shouldBe now
  }

  it should "expect zero spend for a window that has not started" in {
    val tracker = uniformTracker
    val jstStart = Instant.parse("2026-07-13T15:00:00Z")
    val now = Instant.parse("2026-07-13T14:00:00Z") // before the window opens

    val infos = Seq(CampaignId("c-jst") -> spendInfo(jstStart, budget = 50.0, timezone = "Asia/Tokyo"))
    val (expected, maxWindowEnd) = PacingLogic.computeAggregateExpectedSpend(infos, tracker, now)

    expected.toDouble shouldBe 0.0
    maxWindowEnd shouldBe Instant.parse("2026-07-14T15:00:00Z")
  }

  // ==================== liveInfos ====================

  private def spentInfo(budget: Double, spend: Double): CachedSpendInfo =
    CachedSpendInfo(
      advertiserId = AdvertiserId("adv-1"),
      dailyBudget = Budget(budget),
      todaySpend = Spend(spend),
      dayStart = Instant.parse("2026-07-13T00:00:00Z"),
      timestamp = Instant.parse("2026-07-13T00:00:00Z"),
      timezone = ""
    )

  "liveInfos" should "drop campaigns whose spend reached their budget and keep the rest" in {
    val infos = Seq(
      CampaignId("live") -> spentInfo(budget = 10.0, spend = 4.0),
      CampaignId("exact") -> spentInfo(budget = 5.0, spend = 5.0),
      CampaignId("over") -> spentInfo(budget = 5.0, spend = 5.5),
      CampaignId("fresh") -> spentInfo(budget = 5.0, spend = 0.0)
    )
    PacingLogic.liveInfos(infos).map(_._1.value) shouldBe Seq("live", "fresh")
  }

  it should "drop a campaign that can no longer afford one impression at its cheapest CPM" in {
    // Functional exhaustion: campaigns die with dust remaining (observed
    // live: remaining=$0.0022 against $0.005+ clearing prices). With a
    // min-CPM map the filter fires on the dust; without it the strict
    // check keeps the campaign forever.
    val dusty = CampaignId("dusty") -> spentInfo(budget = 2.0, spend = 1.9978)
    val funded = CampaignId("funded") -> spentInfo(budget = 10.0, spend = 5.0)
    val minCpm = Map(CampaignId("dusty") -> 6.0, CampaignId("funded") -> 8.0) // one imp = $0.006 / $0.008
    PacingLogic.liveInfos(Seq(dusty, funded), minCpm).map(_._1.value) shouldBe Seq("funded")
    // Same dust WITHOUT cpm knowledge falls back to the strict check.
    PacingLogic.liveInfos(Seq(dusty, funded)).map(_._1.value) shouldBe Seq("dusty", "funded")
  }

  it should "compute the per-campaign minimum CPM from the candidate pool" in {
    import promovolve.{ CategoryId, CPM, CreativeId }
    import promovolve.publisher.{ CandidateView, CDNPath, MimeType }
    def cand(camp: String, cpm: Double): CandidateView =
      CandidateView(
        creativeId = CreativeId(s"cr-$camp-$cpm"),
        campaignId = CampaignId(camp),
        advertiserId = AdvertiserId("adv-1"),
        assetUrl = CDNPath("https://cdn.example/x"),
        mime = MimeType("image/png"),
        width = 300,
        height = 250,
        category = CategoryId("653"),
        cpm = CPM(cpm),
        classifiedAtMs = 0L
      )
    val m = PacingLogic.minCpmByCampaign(Vector(cand("a", 8.0), cand("a", 3.0), cand("b", 5.0)))
    m(CampaignId("a")) shouldBe 3.0
    m(CampaignId("b")) shouldBe 5.0
  }

  it should "return empty when every campaign is spent (caller refuses the serve)" in {
    val infos = Seq(
      CampaignId("a") -> spentInfo(budget = 5.0, spend = 5.0),
      CampaignId("b") -> spentInfo(budget = 2.0, spend = 2.0)
    )
    PacingLogic.liveInfos(infos) shouldBe empty
  }

  // ==================== perCampaignPaceRatios ====================

  "perCampaignPaceRatios" should "rate each campaign against its OWN expected spend" in {
    // Pool fraction 0.5: whale $10 with $5 spent = exactly on pace (1.0);
    // small $2 with $1.5 spent = 1.5x ahead; fresh $2 with nothing = 0.
    val infos = Seq(
      CampaignId("whale") -> spentInfo(budget = 10.0, spend = 5.0),
      CampaignId("ahead") -> spentInfo(budget = 2.0, spend = 1.5),
      CampaignId("fresh") -> spentInfo(budget = 2.0, spend = 0.0)
    )
    val r = PacingLogic.perCampaignPaceRatios(
      infos, Map.empty, uniformTracker, Instant.parse("2026-07-13T12:00:00Z"),
      zoneAware = false, dayDurationSeconds = 300, poolFraction = 0.5
    )
    r(CampaignId("whale")) shouldBe 1.0 +- 1e-9
    r(CampaignId("ahead")) shouldBe 1.5 +- 1e-9
    r(CampaignId("fresh")) shouldBe 0.0 +- 1e-9
  }

  it should "include pending spend and floor the denominator at the slack" in {
    val infos = Seq(CampaignId("c") -> spentInfo(budget = 10.0, spend = 0.05))
    // Near day start (fraction ~0): denominator floors at 1% of budget
    // ($0.10) instead of exploding; spend 0.05 + pending 0.05 = 0.10 → 1.0.
    val r = PacingLogic.perCampaignPaceRatios(
      infos, Map(CampaignId("c") -> (0.05, Instant.parse("2026-07-13T00:00:00Z"))),
      uniformTracker, Instant.parse("2026-07-13T00:00:01Z"),
      zoneAware = false, dayDurationSeconds = 300, poolFraction = 0.0
    )
    r(CampaignId("c")) shouldBe 1.0 +- 1e-9
  }

  it should "keep the aggregate truthful: exhausted spend leaves BOTH sums" in {
    // Whale on pace + a spent-out small: unfiltered, the small reads as
    // phantom over-pace (its whole budget vs a fraction of expected); with
    // liveInfos the aggregate is exactly the whale's own pace.
    val whale = CampaignId("whale") -> spentInfo(budget = 10.0, spend = 5.0)
    val dead = CampaignId("dead") -> spentInfo(budget = 2.0, spend = 2.0)
    val live = PacingLogic.liveInfos(Seq(whale, dead))
    val (budget, spend, _) = PacingLogic.computeAggregateBudget(
      live,
      Map(whale._1 -> 8.0),
      Map.empty
    )
    budget shouldBe BigDecimal(10.0)
    spend shouldBe BigDecimal(5.0)
  }
}
