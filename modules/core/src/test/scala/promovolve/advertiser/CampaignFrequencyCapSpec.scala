package promovolve.advertiser

import com.typesafe.config.ConfigFactory
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.actor.typed.{ ActorRef, ActorSystem }
import org.apache.pekko.actor.typed.pubsub.Topic
import org.apache.pekko.actor.typed.scaladsl.Behaviors
import org.apache.pekko.cluster.sharding.typed.scaladsl.{ ClusterSharding, Entity }
import org.apache.pekko.cluster.typed.{ Cluster, Join }
import org.scalatest.BeforeAndAfterAll
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import promovolve.*
import promovolve.publisher.CategoryDemandRepo

import scala.concurrent.{ ExecutionContext, Future }
import scala.concurrent.duration.*

/**
 * Frequency cap on the campaign (docs/design/FREQUENCY_CAPPING.md): the pure
 * API-validation rules, and the UpdateConfig tri-state against a REAL
 * CampaignEntity (DurableStateBehavior on the persistence-testkit state
 * plugin) — set, no-change, clear — read back through GetCampaign. This is
 * the first spec to drive UpdateConfig end to end; the scaffold mirrors
 * CampaignEntityRolloverSpec (advertiser stub ignores everything, directory
 * ignores everything — a paused campaign never registers anyway).
 */
class CampaignFrequencyCapSpec extends AnyWordSpec with Matchers with BeforeAndAfterAll {

  import CampaignEntity.FrequencyCap

  "FrequencyCap rules" should {
    "know exactly three windows, in milliseconds" in {
      FrequencyCap.windowMs("hour") shouldBe Some(3_600_000L)
      FrequencyCap.windowMs("day") shouldBe Some(86_400_000L)
      FrequencyCap.windowMs("week") shouldBe Some(604_800_000L)
      FrequencyCap.windowMs("month") shouldBe None
      FrequencyCap.windowMs("") shouldBe None
    }
    "accept 0 as 'no cap' whatever the window says" in {
      FrequencyCap.validate(0, "day") shouldBe None
      FrequencyCap.validate(0, "") shouldBe None
      FrequencyCap.fromApi(0, "day") shouldBe None
    }
    "accept 1..100 with a known window" in {
      FrequencyCap.validate(1, "hour") shouldBe None
      FrequencyCap.validate(100, "week") shouldBe None
      FrequencyCap.fromApi(3, "day") shouldBe Some(FrequencyCap(3, "day"))
    }
    "reject out-of-range impressions and unknown windows, and say why" in {
      FrequencyCap.validate(-1, "day").exists(_.contains("between 1 and 100")) shouldBe true
      FrequencyCap.validate(101, "day").exists(_.contains("between 1 and 100")) shouldBe true
      FrequencyCap.validate(2, "fortnight").exists(_.contains("window must be one of")) shouldBe true
    }
  }

  private val testConfig = ConfigFactory.parseString(
    """
      |pekko {
      |  loglevel = "WARNING"
      |  actor {
      |    provider = "cluster"
      |    serializers {
      |      jackson-cbor = "org.apache.pekko.serialization.jackson.JacksonCborSerializer"
      |    }
      |    serialization-bindings {
      |      "promovolve.CborSerializable" = jackson-cbor
      |    }
      |  }
      |  remote.artery {
      |    canonical.hostname = "127.0.0.1"
      |    canonical.port = 0
      |  }
      |  cluster {
      |    seed-nodes = []
      |    downing-provider-class = "org.apache.pekko.cluster.sbr.SplitBrainResolverProvider"
      |  }
      |  persistence {
      |    state.plugin = "pekko.persistence.testkit.state"
      |    journal.plugin = "pekko.persistence.journal.inmem"
      |  }
      |}
      |""".stripMargin
  )

  val testKit: ActorTestKit = ActorTestKit(testConfig)
  given system: ActorSystem[?] = testKit.system
  given ec: ExecutionContext = system.executionContext

  private val cluster = Cluster(testKit.system)
  cluster.manager ! Join(cluster.selfMember.address)
  lazy val sharding: ClusterSharding = ClusterSharding(testKit.system)

  sharding.init(Entity(AdvertiserEntity.TypeKey)(_ =>
    Behaviors.receiveMessage[AdvertiserEntity.Command | AdvertiserEntity.DDataUpdateResponse] { _ =>
      Behaviors.same
    }
  ))

  private val directory: ActorRef[CampaignDirectory.Command] =
    testKit.spawn(Behaviors.ignore[CampaignDirectory.Command])
  private val budgetTopic: ActorRef[Topic.Command[BudgetEvent]] =
    testKit.spawn(Topic[BudgetEvent]("campaign-frequency-cap-budget-events"))

  private object NoopDemandRepo extends CategoryDemandRepo {
    def upsertCampaign(categoryIds: Set[String], campaignId: String, advertiserId: String): Future[Unit] =
      Future.successful(())
    def removeCampaign(campaignId: String): Future[Unit] = Future.successful(())
    def listByCategory(categoryId: String): Future[Vector[(String, String)]] = Future.successful(Vector.empty)
  }

  override def afterAll(): Unit = testKit.shutdownTestKit()

  private def spawnCampaign(campaignId: String): ActorRef[CampaignEntity.Command] =
    testKit.spawn(
      CampaignEntity(
        campaignId = CampaignId(campaignId),
        advertiserId = AdvertiserId("adv-freq"),
        directory = directory,
        sharding = sharding,
        categoryDemandRepo = NoopDemandRepo,
        budgetEventTopic = budgetTopic
      )
    )

  private def updateCap(
      c: ActorRef[CampaignEntity.Command],
      cap: Option[Option[FrequencyCap]]
  ): Unit = {
    val probe = testKit.createTestProbe[CampaignEntity.ConfigUpdated]()
    c ! CampaignEntity.UpdateConfig(maxCpm = None, dailyBudget = None, frequencyCap = cap, replyTo = probe.ref)
    probe.receiveMessage(5.seconds)
  }

  private def info(c: ActorRef[CampaignEntity.Command]): CampaignEntity.CampaignInfo = {
    val probe = testKit.createTestProbe[CampaignEntity.CampaignInfo]()
    c ! CampaignEntity.GetCampaign(probe.ref)
    probe.receiveMessage(5.seconds)
  }

  "CampaignEntity.UpdateConfig.frequencyCap" should {
    "default to uncapped" in {
      val c = spawnCampaign("camp-cap-default")
      info(c).frequencyCap shouldBe None
    }
    "set, leave alone on None, and clear on Some(None)" in {
      val c = spawnCampaign("camp-cap-tristate")
      updateCap(c, Some(Some(FrequencyCap(3, "day"))))
      info(c).frequencyCap shouldBe Some(FrequencyCap(3, "day"))

      updateCap(c, None) // an unrelated config edit must not touch it
      info(c).frequencyCap shouldBe Some(FrequencyCap(3, "day"))

      updateCap(c, Some(Some(FrequencyCap(1, "hour"))))
      info(c).frequencyCap shouldBe Some(FrequencyCap(1, "hour"))

      updateCap(c, Some(None))
      info(c).frequencyCap shouldBe None
    }
  }
}
