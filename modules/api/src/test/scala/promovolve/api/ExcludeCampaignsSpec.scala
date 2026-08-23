package promovolve.api

import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import promovolve.CampaignId
import spray.json.*

/**
 * The serve side of frequency capping (docs/design/FREQUENCY_CAPPING.md):
 * the browser's `excludeCampaigns` merges into the hard exclusion set next
 * to off-page pins, bounded and deduped; the request parses without the
 * field (older tags); the response carries the campaign's policy.
 */
class ExcludeCampaignsSpec extends AnyWordSpec with Matchers with ServeJson {

  "ExcludeCampaigns.merge" should {
    "union the browser's list with the pins' campaigns" in {
      ExcludeCampaigns.merge(Set(CampaignId("pinned")), Some(Vector("capped-1", "capped-2"))) shouldBe
      Set(CampaignId("pinned"), CampaignId("capped-1"), CampaignId("capped-2"))
    }
    "be the pins alone when the browser sends nothing" in {
      ExcludeCampaigns.merge(Set(CampaignId("pinned")), None) shouldBe Set(CampaignId("pinned"))
      ExcludeCampaigns.merge(Set.empty, Some(Vector.empty)) shouldBe Set.empty
    }
    "trim, drop blanks and dedupe" in {
      ExcludeCampaigns.merge(Set.empty, Some(Vector(" a ", "", "a", "b", "  "))) shouldBe
      Set(CampaignId("a"), CampaignId("b"))
    }
    "take at most MaxEntries, in the order sent (most recent first by contract)" in {
      val sent = (1 to 40).map(i => s"c$i").toVector
      val merged = ExcludeCampaigns.merge(Set.empty, Some(sent))
      merged should have size ExcludeCampaigns.MaxEntries
      merged should contain(CampaignId("c1"))
      merged should contain(CampaignId("c32"))
      merged should not contain CampaignId("c33")
    }
  }

  "BatchServeReq format" should {
    "parse a request without excludeCampaigns (older ad tags)" in {
      val req = """{"pub":"site-1","url":"https://example.com/a","imp":[]}""".parseJson.convertTo[BatchServeReq]
      req.excludeCampaigns shouldBe None
      req.pins shouldBe None
    }
    "parse a request with excludeCampaigns" in {
      val req = """{"pub":"site-1","url":"https://example.com/a","imp":[],"excludeCampaigns":["x","y"]}""".parseJson
        .convertTo[BatchServeReq]
      req.excludeCampaigns shouldBe Some(Vector("x", "y"))
    }
  }

  "ServeRes format" should {
    "carry frequencyCap when set and omit it when not" in {
      val base = ServeRes("a", "image/png", "click", "imp", "cta", "cr1", 1L, "https://example.com")
      base.toJson.asJsObject.fields.get("frequencyCap") shouldBe None
      val capped = base.copy(frequencyCap = Some(FrequencyCapWire(3, 86_400_000L)))
      capped.toJson.asJsObject.fields("frequencyCap") shouldBe
      JsObject("n" -> JsNumber(3), "windowMs" -> JsNumber(86_400_000L))
      capped.toJson.convertTo[ServeRes] shouldBe capped
    }
  }
}
