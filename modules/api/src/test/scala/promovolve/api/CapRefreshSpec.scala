package promovolve.api

import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

/**
 * Which "is this still capped?" questions the server will answer.
 *
 * A browser at a campaign's cap excludes it, so it can never win, so it can
 * never be told the cap changed the normal way — on a winner. This is the
 * back channel, and it carries the same ids as the exclusion list, so it
 * gets the same bound: a client that cannot blank its auction with
 * thousands of exclusions must not be able to spend the server's lookups
 * either.
 */
class CapRefreshSpec extends AnyWordSpec with Matchers {

  "CapRefresh.wanted" should {

    "pass through well-formed entries" in {
      CapRefresh.wanted(Some(Vector(CapCheck("camp-1", "cre-1")))) shouldBe
      Vector(CapCheck("camp-1", "cre-1"))
    }

    "be empty for an absent or empty list" in {
      CapRefresh.wanted(None) shouldBe Vector.empty
      CapRefresh.wanted(Some(Vector.empty)) shouldBe Vector.empty
    }

    "trim, and drop an entry missing either half" in {
      CapRefresh.wanted(Some(Vector(
        CapCheck("  camp-1  ", " cre-1 "),
        CapCheck("", "cre-2"),
        CapCheck("camp-3", "   ")
      ))) shouldBe Vector(CapCheck("camp-1", "cre-1"))
    }

    // One answer per campaign is all the browser can use, and the first
    // entry is the one it chose to ask with.
    "keep one entry per campaign, in order" in {
      CapRefresh.wanted(Some(Vector(
        CapCheck("camp-1", "cre-a"),
        CapCheck("camp-2", "cre-b"),
        CapCheck("camp-1", "cre-c")
      ))) shouldBe Vector(CapCheck("camp-1", "cre-a"), CapCheck("camp-2", "cre-b"))
    }

    "bound the list at the same limit the exclusions get" in {
      val many = (1 to CapRefresh.MaxEntries + 20).map(i => CapCheck(s"camp-$i", s"cre-$i")).toVector
      CapRefresh.wanted(Some(many)) should have size CapRefresh.MaxEntries
      CapRefresh.MaxEntries shouldBe ExcludeCampaigns.MaxEntries
    }
  }
}
