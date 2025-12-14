package com.example

import org.scalatestplus.scalacheck.ScalaCheckPropertyChecks

class PropertyTest extends org.scalatest.funsuite.AnyFunSuite with ScalaCheckPropertyChecks {
  property("property test example") {
    forAll { (x: Int) =>
      assert(x + 0 == x)
    }
  }
}
