package promovolve.publisher

import java.time.Instant

import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

/**
 * Safety flags are ADVISORY except adult content.
 *
 * They were all hard blocks until 2026-07-27, and the failure was silent in
 * both directions: `canParticipate` kept a flagged creative out of the
 * publisher's approval queue while it went on bidding and winning slots, so it
 * could never be approved, never served, and neither dashboard said why. It
 * also made the call on the publisher's behalf — an ad FOR a crime drama is
 * not a violent ad, and a blanket veto rules out film, TV and games
 * advertising wholesale. The approval queue exists so the publisher decides.
 *
 * None of that was covered by a test, which is why it survived. These lock the
 * boundary: adult content never bids; violence and hate speech always bid and
 * carry their reason forward for a human to weigh.
 */
final class CreativeSafetySpec extends AnyWordSpec with Matchers {

  private def creative(
      adult: Boolean = false,
      violence: Boolean = false,
      hate: Boolean = false,
      status: CreativeStatus = CreativeStatus.Active
  ): Creative =
    Creative(
      creativeId = "01TEST",
      imageHash = "hash",
      advertiserId = "adv",
      campaignId = "camp",
      name = "Creative",
      landingUrl = "https://example.jp/",
      landingDomain = "example.jp",
      createdAt = Instant.EPOCH,
      s3Key = "key",
      mime = "image/png",
      width = 300,
      height = 250,
      adultContent = adult,
      violence = violence,
      hateSpeech = hate,
      status = status
    )

  "a clean creative" should {
    "bid and carry no advisories" in {
      val c = creative()
      c.isSafetyBlocked shouldBe false
      c.canParticipate shouldBe true
      c.safetyAdvisories shouldBe Nil
    }
  }

  "adult content" should {
    "hard-block — the one thing the network will not carry at any price" in {
      val c = creative(adult = true)
      c.isSafetyBlocked shouldBe true
      c.canParticipate shouldBe false
    }
  }

  "violence" should {
    "stay biddable so it reaches the queue the publisher reviews" in {
      val c = creative(violence = true)
      c.isSafetyBlocked shouldBe false
      c.canParticipate shouldBe true
      c.safetyAdvisories should contain("violence")
    }
  }

  "hate speech" should {
    "also be advisory rather than a veto" in {
      val c = creative(hate = true)
      c.canParticipate shouldBe true
      c.safetyAdvisories should contain("hate_speech")
    }
  }

  "several advisory flags" should {
    "all be reported, so the publisher sees the whole picture" in {
      creative(violence = true, hate = true).safetyAdvisories should
      contain theSameElementsAs List("violence", "hate_speech")
    }
  }

  "adult content alongside advisories" should {
    "still hard-block — the advisories do not soften it" in {
      val c = creative(adult = true, violence = true)
      c.canParticipate shouldBe false
      c.safetyAdvisories should contain("violence")
    }
  }

  "a paused creative" should {
    "not bid regardless of a clean safety record" in {
      creative(status = CreativeStatus.Paused).canParticipate shouldBe false
    }
  }
}
