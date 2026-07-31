package promovolve.api

import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

/**
 * Pins the ingest downscale rule. The regression that motivated it: a
 * 1000×11000 page-strip JPEG (a whole LP section exported as one tall
 * image — ubiquitous on Japanese landing pages) was long-edge capped to
 * 2000, crushing its width to 182px. Strips cap the SHORT edge instead.
 */
class ImageCompressionSpec extends AnyWordSpec with Matchers {

  private def scaled(w: Int, h: Int): (Int, Int) = {
    val s = ImageCompression.scaleFor(w, h)
    (math.round(w * s).toInt, math.round(h * s).toInt)
  }

  "scaleFor" should {
    "long-edge cap normal photos at 2000" in {
      scaled(4000, 3000) shouldBe (2000, 1500)
      scaled(3000, 3000) shouldBe (2000, 2000)
    }

    "leave small images untouched" in {
      scaled(1200, 800) shouldBe (1200, 800)
    }

    "preserve a page-strip's width (the 1000×11000 regression)" in {
      val (w, h) = scaled(1000, 11000)
      w shouldBe 909 +- 2 // long-edge ceiling 10000, NOT width 182
      h shouldBe 10000 +- 2
    }

    "not upscale a narrow strip already within bounds" in {
      scaled(800, 4000) shouldBe (800, 4000)
    }

    "still bound a strip's short edge at 2000" in {
      val (w, h) = scaled(3000, 12000)
      w shouldBe 2000 +- 2
      h shouldBe 8000 +- 2
    }
  }
}
