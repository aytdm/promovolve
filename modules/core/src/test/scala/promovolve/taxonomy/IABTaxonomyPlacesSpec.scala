package promovolve.taxonomy

import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

/**
 * Tier 1 of docs/design/GEOGRAPHIC_CONTEXT.md — the classifier answering
 * "where is this page about?" alongside "what is it about?".
 *
 * The parsing is deliberately tolerant on shape and the VALIDATION is
 * deliberately strict: the model emits ISO-shaped codes from its own
 * knowledge because the table is far too large to list in a prompt, so the
 * shipped table is the guarantee, not the prompt.
 */
class IABTaxonomyPlacesSpec extends AnyWordSpec with Matchers {

  "placesFrom" should {

    "read the documented shape" in {
      IABTaxonomy.placesFrom("""{"selected_taxonomy_ids": [], "places": ["JP-13"]}""") shouldBe List("JP-13")
    }

    "read several places" in {
      IABTaxonomy.placesFrom("""{"places": ["JP", "FR"]}""") shouldBe List("JP", "FR")
    }

    // A page about nowhere in particular is the COMMON case, and both the
    // empty array and the absent key must mean that rather than an error.
    "treat an empty array and an absent key alike" in {
      IABTaxonomy.placesFrom("""{"places": []}""") shouldBe Nil
      IABTaxonomy.placesFrom("""{"selected_taxonomy_ids": []}""") shouldBe Nil
    }

    // Models drift between a bare string and {"code": ...}; both carry
    // everything we need, so neither is worth discarding a classification
    // over.
    "accept an object-wrapped code" in {
      IABTaxonomy.placesFrom("""{"places": [{"code": "JP-13"}]}""") shouldBe List("JP-13")
    }

    "survive malformed input without throwing" in {
      IABTaxonomy.placesFrom("not json") shouldBe Nil
      IABTaxonomy.placesFrom("""{"places": "JP"}""") shouldBe Nil
      IABTaxonomy.placesFrom("[]") shouldBe Nil
    }

    "drop blank entries" in {
      IABTaxonomy.placesFrom("""{"places": ["", "  ", "JP"]}""") shouldBe List("JP")
    }
  }

  "the closed-vocabulary gate" should {

    // This is the pairing that matters: parsing is permissive, Places.validate
    // is not. A hallucinated or mis-cased code must never reach the auction,
    // because downstream matching is plain set intersection and a bogus code
    // would simply never match anything while looking like real targeting.
    "keep only codes the shipped table knows" in {
      val parsed = IABTaxonomy.placesFrom("""{"places": ["JP-13", "XX-99", "Tokyo", "JP"]}""")
      Places.validate(parsed) shouldBe Set("JP-13", "JP")
    }

    "resolve a validated subdivision to the expected place" in {
      Places.get("JP-13").map(_.name) shouldBe Some("Tokyo")
    }

    // The analyze() pairing for a named city: parse the "City, CODE" string
    // as-is, resolve it in scope, then validate. The Kanazawa article
    // classifies to the city, and a made-up town degrades to its prefecture.
    "resolve a 'City, CODE' answer to the city and degrade the unknown town" in {
      val parsed = IABTaxonomy.placesFrom("""{"places": ["Kanazawa, JP-17", "Nowhere, JP-20", "JP"]}""")
      parsed shouldBe List("Kanazawa, JP-17", "Nowhere, JP-20", "JP")
      Places.validate(parsed.flatMap(Places.resolveEmitted)) shouldBe Set("GN1860243", "JP-20", "JP")
    }
  }

  "the prompt" should {

    val candidates = Map("150" -> "Attractions")

    def promptWith(placeHint: Option[String]): String = {
      given system: org.apache.pekko.actor.typed.ActorSystem[Nothing] =
        org.apache.pekko.actor.typed.ActorSystem(
          org.apache.pekko.actor.typed.scaladsl.Behaviors.empty, "iab-prompt-spec")
      given scala.concurrent.ExecutionContext = system.executionContext
      try new IABTaxonomy(IABTaxonomy.Provider.Gemini("k"))
          .buildPrompt("https://x/y", "text", candidates, None, placeHint)
      finally system.terminate()
    }

    "ask for places and show the response shape" in {
      val prompt = promptWith(None)
      prompt should include("ISO 3166-1")
      prompt should include("\"places\"")
      prompt should include("empty list")
    }

    // A city is asked for as "Name, CODE" — the code is what makes it
    // resolvable in scope, so the prompt must show the form and insist on it.
    "ask for a city as 'Name, CODE' with the code never omitted" in {
      val prompt = promptWith(None)
      prompt should include("\"Kanazawa, JP-17\"")
      prompt should include("never omit it")
    }

    // Live 2026-08-22: an article about Kinosaki Onsen (a district of
    // Toyooka, absent from cities5000) came back places=[] — the model had no
    // way to say it and took the "empty is correct" exit. A small spot must
    // fall back to its enclosing city or subdivision, not to nothing.
    "tell the model to name the enclosing place for somewhere smaller than a city" in {
      val prompt = promptWith(None)
      prompt should include("\"Toyooka, JP-28\"")
      prompt should include("not an\nempty list")
    }

    // The place hint is publisher-controlled text entering a prompt and the
    // publisher is paid by the answer — the same hazard as the topic hint,
    // so it gets the same framing rather than being trusted.
    "frame a publisher place hint as an unverified claim" in {
      val prompt = promptWith(Some("Kyoto"))
      prompt should include("SELF-REPORTED, NOT VERIFIED")
      prompt should include("Kyoto")
      prompt should include("ignore it entirely")
    }
  }
}
