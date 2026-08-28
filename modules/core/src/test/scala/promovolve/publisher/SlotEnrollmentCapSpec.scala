package promovolve.publisher

import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

/**
 * The slot-enrollment cap: slots auto-enroll from live traffic, every
 * distinct id becomes a permanent inventory row and its own learning unit,
 * and nothing else bounds how many ids a page can mint (a broken theme, a
 * hand-written per-post scheme, a hostile page). The cap turns "slots are
 * shared learning units" from a plugin courtesy (per-post scope removed in
 * WP 0.6.0) into a server-enforced invariant.
 *
 * The arithmetic is pure (SiteEntity.admitSlots); the entity applies it at
 * BOTH enrollment doors — ActivateServeSlots and the ContentAnalyzed
 * slot merge — because a cap with a second uncapped door is theater.
 */
class SlotEnrollmentCapSpec extends AnyWordSpec with Matchers {

  private def slot(id: String) = SiteEntity.AdSlotConfig(slotId = id, width = 300, height = 250)

  "SiteEntity.admitSlots" should {

    "admit everything while under the cap" in {
      val (admitted, dropped) = SiteEntity.admitSlots(existingCount = 3, added = List(slot("a"), slot("b")), cap = 10)
      admitted.map(_.slotId) shouldBe List("a", "b")
      dropped shouldBe empty
    }

    "admit exactly up to the cap and drop the rest, preserving order" in {
      val (admitted, dropped) =
        SiteEntity.admitSlots(existingCount = 8, added = List(slot("a"), slot("b"), slot("c")), cap = 10)
      admitted.map(_.slotId) shouldBe List("a", "b")
      dropped.map(_.slotId) shouldBe List("c")
    }

    "admit nothing at or over the cap" in {
      SiteEntity.admitSlots(existingCount = 10, added = List(slot("a")), cap = 10)._1 shouldBe empty
      // Over-cap (rows enrolled before the cap existed): degrade, don't
      // misbehave — negative room must not throw or admit.
      SiteEntity.admitSlots(existingCount = 12, added = List(slot("a")), cap = 10)._1 shouldBe empty
    }

    "never touch what is already enrolled — the cap gates the DOOR, not the room" in {
      // Expressed by the signature itself: admitSlots sees only a COUNT of
      // existing slots, so it cannot drop one. This pins the shape.
      val (admitted, dropped) = SiteEntity.admitSlots(existingCount = 9, added = List(slot("x")), cap = 10)
      admitted.map(_.slotId) shouldBe List("x")
      dropped shouldBe empty
    }

    "carry a generous default far above any real template design" in {
      SiteEntity.MaxSlotsPerSite should be >= 100
    }
  }
}
