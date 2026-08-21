package promovolve.publisher

import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import promovolve.*

/**
 * The pure predicate behind `SiteEntity.expireStaleClassifications`: which
 * persisted classifications are BEHIND and must re-classify on their next
 * view. Two causes, both recorded in state so the answer survives restarts:
 *
 *   - produced by an older classifier (`classifierVersion` below current —
 *     the pre-geo entries with no place data that left the Kanazawa article
 *     unmatched by a Kanazawa campaign until its 48h window lapsed);
 *   - produced before the publisher last changed a classifier-relevant
 *     setting (`State.reclassifyBefore`, stamped by UpdateConfig).
 *
 * The send (AdServer.ExpireClassification) and the AdServer-side pin are
 * exercised in AdServerServeAccountingSpec; this is the selection.
 */
class StaleClassificationSpec extends AnyWordSpec with Matchers {

  private val siteId = SiteId("test-site")
  private val Current = SiteEntity.ClassificationEntry.CurrentClassifierVersion

  private def entry(ts: Long, version: Int = Current, places: Set[String] = Set.empty) =
    SiteEntity.ClassificationEntry(
      categories = Map("IAB1" -> 0.8),
      slots = Vector.empty,
      classifiedAt = ts,
      places = places,
      classifierVersion = version
    )

  private def state(entries: (String, SiteEntity.ClassificationEntry)*): SiteEntity.State =
    entries.foldLeft(SiteEntity.State.empty(siteId)) { case (s, (url, e)) => s.withClassification(url, e) }

  "State.staleClassifications" should {

    "be empty when every entry is current and no setting has changed" in {
      state("https://a" -> entry(100L), "https://b" -> entry(200L)).staleClassifications.toList shouldBe Nil
    }

    // The live case: a Jackson-recovered pre-geo entry has the default
    // version 0 and places = ∅, which place-targeted demand reads as
    // "about nowhere". It must not wait out the freshness window.
    "flag entries from an older classifier, whatever their age" in {
      val s = state(
        "https://old" -> entry(ts = Long.MaxValue - 1, version = 0),
        "https://new" -> entry(ts = 1L, version = Current, places = Set("GN1860243"))
      )
      s.staleClassifications.map(_._1).toSet shouldBe Set("https://old")
    }

    "treat a pre-versioning default as older" in {
      val recovered = SiteEntity.ClassificationEntry(Map.empty, Vector.empty, classifiedAt = 5L)
      recovered.classifierVersion shouldBe 0
      state("https://x" -> recovered).staleClassifications.map(_._1).toList shouldBe List("https://x")
    }

    "flag entries classified at or before the publisher's last settings change" in {
      val s = state(
        "https://before" -> entry(100L),
        "https://at"     -> entry(500L),
        "https://after"  -> entry(501L)
      ).copy(reclassifyBefore = 500L)
      s.staleClassifications.map(_._1).toSet shouldBe Set("https://before", "https://at")
    }

    "not flag anything on the pre-feature default of reclassifyBefore = 0" in {
      // classifiedAt 0 is an impossible real stamp but a cheap way to show
      // the guard: 0 means "never changed", not "everything is older".
      state("https://a" -> entry(0L)).staleClassifications.toList shouldBe Nil
    }

    "leave the set the moment an entry is re-classified" in {
      val s = state("https://a" -> entry(100L, version = 0)).copy(reclassifyBefore = 150L)
      s.staleClassifications.map(_._1).toList shouldBe List("https://a")
      val reclassified = s.withClassification("https://a", entry(151L, version = Current))
      reclassified.staleClassifications.toList shouldBe Nil
    }
  }
}
