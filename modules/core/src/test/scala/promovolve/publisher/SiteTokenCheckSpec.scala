package promovolve.publisher

import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import promovolve.*

/**
 * docs/design/SITE_TOKEN_CHECK.md — the decision behind
 * `CheckVerificationToken`, kept pure so the three answers and their
 * boundaries are pinned without an actor system.
 *
 * What matters here is less the happy path than the edges a public
 * endpoint invites: a site that does not exist must be indistinguishable
 * from one that exists but holds no token (both `Unknown`); and the compare
 * must be byte-exact — no trim, no case folding — because a token is a
 * credential and "close enough" is how credentials leak.
 */
class SiteTokenCheckSpec extends AnyWordSpec with Matchers {

  private val token = VerificationToken.generate()

  "SiteEntity.tokenCheck" should {

    "answer Valid for the site's current token" in {
      SiteEntity.tokenCheck(initialised = true, Some(token), token.value) shouldBe SiteEntity.TokenValid
    }

    "answer Stale for a different token on a live site" in {
      SiteEntity.tokenCheck(initialised = true, Some(token), VerificationToken.generate().value) shouldBe
      SiteEntity.TokenStale
    }

    // Never created, a pre-approval shell, or a tombstone after a site
    // delete — all are "no config", all must read the same.
    "answer Unknown for a site that is not initialised, whatever is presented" in {
      SiteEntity.tokenCheck(initialised = false, None, token.value) shouldBe SiteEntity.TokenUnknown
      SiteEntity.tokenCheck(initialised = false, Some(token), token.value) shouldBe SiteEntity.TokenUnknown
    }

    "answer Unknown for a live site that holds no token" in {
      SiteEntity.tokenCheck(initialised = true, None, token.value) shouldBe SiteEntity.TokenUnknown
    }

    "compare byte-exactly: case, whitespace and the record prefix all matter" in {
      val v = token.value
      SiteEntity.tokenCheck(initialised = true, Some(token), v.toUpperCase) shouldBe SiteEntity.TokenStale
      SiteEntity.tokenCheck(initialised = true, Some(token), s" $v") shouldBe SiteEntity.TokenStale
      SiteEntity.tokenCheck(initialised = true, Some(token), s"promovolve-site-verification=$v") shouldBe
      SiteEntity.TokenStale
      SiteEntity.tokenCheck(initialised = true, Some(token), "") shouldBe SiteEntity.TokenStale
    }
  }
}
