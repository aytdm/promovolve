package promovolve.publisher.delivery.candidates

import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import promovolve.*
import promovolve.publisher.{ CDNPath, CandidateView, MimeType }

/**
 * The serve-side half of place targeting (CandidateLogic.forPage).
 *
 * The auction is per URL and applies placeAdmits correctly; the ServeIndex
 * is per site|slot and a slot id is shared by every page that uses it. So a
 * candidate that won the Kanazawa article lands in the `…-travel` slot's
 * pool and — before this — was served and billed on the Tainan article
 * sharing the slot (live, 2026-08-22). This pins the re-check at serve:
 * eligibility against the page actually being served, and the relevance
 * decay for THAT page's distance.
 */
class PlaceForPageSpec extends AnyWordSpec with Matchers {

  private val Kanazawa = "GN1860243" // city, JP-17
  private val Ishikawa = "JP-17"
  private val Tainan   = "TW-TNN"

  private def view(id: String, targeting: Set[String], score: Double = 0.5): CandidateView =
    CandidateView(
      creativeId = CreativeId(id),
      campaignId = CampaignId(s"camp-$id"),
      advertiserId = AdvertiserId(s"adv-$id"),
      assetUrl = CDNPath(s"/assets/$id.png"),
      mime = MimeType.imagePng,
      width = 300,
      height = 250,
      category = CategoryId("679"),
      cpm = CPM(5.0),
      classifiedAtMs = 0L,
      categoryScore = score,
      placeTargeting = targeting
    )

  private val fourSeasons = view("fs", Set(Kanazawa))     // targets the city
  private val japanWide   = view("jp", Set("JP"))         // targets the country
  private val untargeted  = view("any", Set.empty)        // no place constraint

  "CandidateLogic.forPage" should {

    // The live bug: the Kanazawa-targeted candidate reached the Tainan page
    // through the shared `…-travel` slot and was served there.
    "drop a place-targeted candidate on a page about somewhere else" in {
      val kept = CandidateLogic.forPage(Vector(fourSeasons, untargeted), Set(Tainan))
      kept.map(_.creativeId.value) shouldBe Vector("any")
    }

    "keep it on the page it targets, undecayed" in {
      val kept = CandidateLogic.forPage(Vector(fourSeasons), Set(Kanazawa))
      kept.map(_.creativeId.value) shouldBe Vector("fs")
      kept.head.categoryScore shouldBe 0.5
    }

    // The inventory side expands to ancestors, the targeting side does not:
    // a Japan-wide campaign is eligible on the Kanazawa article, at a
    // distance — city → prefecture → country is two hops, 0.7² = 0.49×.
    "keep a broader target on a narrower page, decayed by this page's distance" in {
      val kept = CandidateLogic.forPage(Vector(japanWide), Set(Kanazawa))
      kept should have size 1
      kept.head.categoryScore shouldBe (0.5 * 0.49 +- 1e-9)
    }

    "decay one hop for the prefecture" in {
      val kept = CandidateLogic.forPage(Vector(japanWide), Set(Ishikawa))
      kept.head.categoryScore shouldBe (0.5 * 0.7 +- 1e-9)
    }

    // Exactly what the campaign does at bid time: a narrower target does not
    // match a page that only says the broader place.
    "drop a narrower target on a broader page" in {
      CandidateLogic.forPage(Vector(fourSeasons), Set(Ishikawa)) shouldBe empty
      CandidateLogic.forPage(Vector(fourSeasons), Set("JP")) shouldBe empty
    }

    // Untargeted demand bids everywhere and is a perfect fit everywhere —
    // no decay, or every untargeted campaign would be quietly penalised.
    "pass untargeted candidates through untouched on any page" in {
      for (places <- List(Set(Kanazawa), Set(Tainan), Set.empty[String])) {
        val kept = CandidateLogic.forPage(Vector(untargeted), places)
        kept shouldBe Vector(untargeted)
      }
    }

    // "About nowhere we know" — classified that way, or never auctioned on
    // this AdServer incarnation. A targeted candidate is dropped, as the
    // campaign would have declined to bid: the cost of a wrong drop is one
    // missed impression, the cost of a wrong keep is a billed impression the
    // advertiser never asked for.
    "drop place-targeted candidates on a page with no known places" in {
      CandidateLogic.forPage(Vector(fourSeasons, japanWide, untargeted), Set.empty)
        .map(_.creativeId.value) shouldBe Vector("any")
    }

    "preserve order among the survivors" in {
      val kept = CandidateLogic.forPage(Vector(untargeted, fourSeasons, japanWide), Set(Kanazawa))
      kept.map(_.creativeId.value) shouldBe Vector("any", "fs", "jp")
    }
  }
}
