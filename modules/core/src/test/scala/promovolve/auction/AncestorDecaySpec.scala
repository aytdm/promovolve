package promovolve.auction

import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import promovolve.publisher.delivery.candidates.CandidateLogic

/**
 * Pins the ancestor-distance relevance model (2026-07-25): ancestor
 * fan-out is REACH, not RELEVANCE. A campaign reached via taxonomy
 * ancestors keeps bidding everywhere it could before, but its serve-time
 * affinity prior decays with distance, so native demand outcompetes it
 * and it degrades to backfill. Motivating case: farm-to-table page
 * classified {Food & Drink, Cooking, Food Industry}; Food Industry →
 * Industries → Business and Finance put B2B security ads on the food
 * page at full native strength.
 */
class AncestorDecaySpec extends AnyWordSpec with Matchers {

  "AuctioneerEntity.expandWithHops" should {

    "give page-native categories distance 0" in {
      val hops = AuctioneerEntity.expandWithHops(List("210"))
      hops("210") shouldBe 0
    }

    "walk the live outage chain: Food Industry (96) -> Industries (90) -> Business (52)" in {
      val hops = AuctioneerEntity.expandWithHops(List("96"))
      hops("96") shouldBe 0
      hops("90") shouldBe 1
      hops("52") shouldBe 2
    }

    "keep the MINIMUM distance when a category is both native and an ancestor" in {
      // Page carries both the child (96) and its grandparent (52)
      // natively — 52 must stay 0, not 2.
      val hops = AuctioneerEntity.expandWithHops(List("96", "52"))
      hops("52") shouldBe 0
      hops("96") shouldBe 0
      hops("90") shouldBe 1
    }

    "cover every category the old flat expansion covered" in {
      val cats = List("96", "210", "497")
      val flat = cats.flatMap { c =>
        c +: promovolve.taxonomy.TieredCategory.getAncestors(c).map(_.id)
      }.toSet
      AuctioneerEntity.expandWithHops(cats).keySet shouldBe flat
    }
  }

  "AncestorAffinityDecay" should {
    "discount per hop: native 1.0x, parent 0.7x, grandparent 0.49x" in {
      math.pow(CandidateLogic.AncestorAffinityDecay, 0) shouldBe 1.0
      math.pow(CandidateLogic.AncestorAffinityDecay, 1) shouldBe 0.7 +- 1e-9
      math.pow(CandidateLogic.AncestorAffinityDecay, 2) shouldBe 0.49 +- 1e-9
    }

    "reorder the farm-to-table case: decayed business prior loses to native food prior" in {
      // securate via 52 at 2 hops with a healthy learned weight vs
      // solitomago native 210 with a mediocre one — native must lead.
      val securatePrior = 0.6 * math.pow(CandidateLogic.AncestorAffinityDecay, 2)
      val solitomagoPrior = 0.5
      securatePrior should be < solitomagoPrior
    }
  }
}
