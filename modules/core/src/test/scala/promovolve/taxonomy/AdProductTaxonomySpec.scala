package promovolve.taxonomy

import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

class AdProductTaxonomySpec extends AnyWordSpec with Matchers {

  "AdProductTaxonomy.selfAndAncestors" should {

    "walk the full tier chain" in {
      // Cannabis Drinks (1051) -> Cannabis Consumables (1050) -> Cannabis (1049)
      AdProductTaxonomy.selfAndAncestors("1051") shouldBe Set("1051", "1050", "1049")
    }

    "return just the id for a top-level category" in {
      AdProductTaxonomy.selfAndAncestors("1544") shouldBe Set("1544") // Tobacco
    }

    "cover the operator-prohibition case: a child of a prohibited parent" in {
      // Prohibiting Tobacco (1544) must catch Cigarettes (1546).
      AdProductTaxonomy.selfAndAncestors("1546") should contain("1544")
    }

    "survive the taxonomy's self-parent quirk without looping" in {
      // Row 1000 (Ad Safety Risk) lists itself as its own parent in the
      // official TSV — the cycle guard must terminate.
      AdProductTaxonomy.selfAndAncestors("1000") shouldBe Set("1000")
    }

    "echo unknown ids back as themselves" in {
      AdProductTaxonomy.selfAndAncestors("no-such-id") shouldBe Set("no-such-id")
    }
  }
}
